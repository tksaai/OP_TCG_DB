// app.js (JSON事前生成方式に対応した最終完成版・省略なし)

// ▼▼▼【最重要】GASを再デプロイして取得した、あなたの新しいウェブアプリURLに必ず置き換えてください ▼▼▼
const CARD_API_URL = 'https://script.google.com/macros/s/AKfycbyOqEM2gXAVpDJcp2QtOwPXrCCbhoh6FlZk1ITn0EWl6bwI0wTPN2cv2GaB_yf1Dit_/exec';

const db = new Dexie('OnePieceCardDB_v2');
db.version(1).stores({
  cards: 'uniqueId, cardNumber, cardName, *color, *features, effectText',
  meta: 'key'
});

const statusMessageElement = document.getElementById('status-message');
const cardListElement = document.getElementById('card-list');
const searchBox = document.getElementById('search-box');

function jsonpRequest(url) {
  return new Promise((resolve, reject) => {
    const callbackName = 'jsonp_callback_' + Date.now() + Math.round(Math.random() * 1000);
    window[callbackName] = function(data) {
      clearTimeout(timeoutId);
      delete window[callbackName];
      if (document.body.contains(script)) document.body.removeChild(script);
      resolve(data);
    };
    const timeoutId = setTimeout(() => {
      delete window[callbackName];
      if (document.body.contains(script)) document.body.removeChild(script);
      reject(new Error('JSONP request timed out.'));
    }, 120000);
    const script = document.createElement('script');
    script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + callbackName;
    script.onerror = () => {
      clearTimeout(timeoutId);
      delete window[callbackName];
      if (document.body.contains(script)) document.body.removeChild(script);
      reject(new Error('JSONP script loading error.'));
    };
    document.body.appendChild(script);
  });
}

/**
 * アプリのメイン初期化処理（修正版）
 */
async function initializeApp() {
  try {
    const cardCount = await db.cards.count();

    if (cardCount > 0) {
      // DBにデータがあれば、まずそれを表示して高速起動
      console.log(`ローカルDBから${cardCount}件のカードを読み込み、表示します。`);
      await displayCards();
      statusMessageElement.style.display = 'none';
      
      // その後、バックグラウンドで静かにデータ更新を試みる
      console.log("バックグラウンドでデータ更新を開始します。");
      syncData().catch(err => {
        // バックグラウンドでの失敗は警告に留める
        console.warn("バックグラウンドでのデータ更新に失敗しました:", err.message);
      });

    } else {
      // DBが空の場合（初回起動）
      console.log("ローカルDBは空です。初回同期を開始します。");
      statusMessageElement.textContent = '初回データ取得中...';
      statusMessageElement.style.display = 'block';
      
      // データ同期が完了するのを待ってから、メッセージを消す
      await syncData();
      statusMessageElement.style.display = 'none';
    }
  } catch (error) {
    console.error("【重大なエラー】初期化処理中に失敗しました:", error);
    statusMessageElement.textContent = `エラー: ${error.message}。`;
  }
}

/**
 * APIから全データを取得し、ローカルDBを更新する
 */
async function syncData() {
  console.log('APIから全件データを取得します...');
  const allCards = await jsonpRequest(CARD_API_URL);

  if (allCards.error) {
    throw new Error(`APIエラー: ${allCards.message}`);
  }
  
  console.log(`APIから ${allCards.length} 件取得しました。`);
  
  await db.transaction('rw', db.cards, async () => {
    await db.cards.clear();
    await db.cards.bulkAdd(allCards);
  });
  
  console.log('ローカルデータベースを更新しました。');
  
  // ★★★ データ更新後に、必ず画面を再描画する ★★★
  await displayCards();
}

/**
 * IndexedDBからカードデータを読み込み、画面に表示する
 */
async function displayCards() {
  try {
    const searchTerm = searchBox.value.toLowerCase().trim();
    let collection = db.cards;
    if (searchTerm) {
      const searchWords = searchTerm.split(/\s+/).filter(word => word.length > 0);
      collection = collection.filter(card => {
        const targetText = [ card.cardName, card.effectText, ...(Array.isArray(card.features) ? card.features : []) ].join(' ').toLowerCase();
        return searchWords.every(word => targetText.includes(word));
      });
    }
    const filteredCards = await collection.toArray();
    
    if (filteredCards.length === 0 && (await db.cards.count()) === 0) {
        statusMessageElement.textContent = 'カードデータがありません。オンラインで再読み込みしてください。';
        statusMessageElement.style.display = 'block';
    }

    cardListElement.innerHTML = '';
    const fragment = document.createDocumentFragment();
    filteredCards.forEach(card => {
      const cardDiv = document.createElement('div');
      cardDiv.className = 'card-item';
      const imageUrl = card.imageUrlSmall || '';
      cardDiv.innerHTML = `<img src="${imageUrl}" alt="${card.cardName}" loading="lazy" onerror="this.style.display='none'">`;
      fragment.appendChild(cardDiv);
    });
    cardListElement.appendChild(fragment);

    console.log(`${filteredCards.length}件のカードを表示しました。`); // 確認用のログ
  } catch(error) {
    console.error("カード表示処理エラー:", error);
  }
}

// イベントリスナーとService Worker登録
searchBox.addEventListener('input', displayCards);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').then(reg => {
      console.log('ServiceWorker登録成功');
    }).catch(err => {
      console.error('ServiceWorker登録失敗:', err);
    });
  });
}

// アプリケーション開始
initializeApp();
