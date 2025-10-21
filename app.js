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
    // まずローカルDBのデータを表示試行（初回は空でもOK）
    await displayCards();

    // その後、バックグラウンドで最新データを取得してDBを更新する
    // この処理が終わったら、再度表示関数が呼ばれる
    await syncData();
    
  } catch (error) {
    console.error("【重大なエラー】初期化またはデータ同期に失敗:", error);
    statusMessageElement.textContent = `エラー: ${error.message}。オフラインデータで表示しています。`;
    // エラーが起きても、最終的にもう一度表示を試みる
    await displayCards();
  }
}

/**
 * APIから全データを取得し、ローカルDBを更新する
 */
async function syncData() {
  statusMessageElement.textContent = '最新データを取得中...';
  statusMessageElement.style.display = 'block';
  console.log('APIから全件データを取得します...');
  
  const allCards = await jsonpRequest(CARD_API_URL);
  if (allCards.error) throw new Error(`APIエラー: ${allCards.message}`);
  
  console.log(`APIから ${allCards.length} 件取得しました。`);
  
  // トランザクション内でクリアと一括追加を行う
  await db.transaction('rw', db.cards, async () => {
    await db.cards.clear();
    await db.cards.bulkAdd(allCards);
  });
  
  console.log('ローカルデータベースを更新しました。');
  
  // データ更新後に、画面を再描画する
  await displayCards(); 
  statusMessageElement.style.display = 'none';
}

/**
 * IndexedDBからカードデータを読み込み、画面に表示する
 */
async function displayCards() {
  try {
    const cardCount = await db.cards.count();
    if (cardCount === 0) {
      // DBが空の場合は何もしない（syncDataが終わるのを待つ）
      console.log("DBは空です。表示するカードがありません。");
      return;
    }

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
    
    statusMessageElement.style.display = 'none';

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

    console.log(`${filteredCards.length}件のカードを表示しました。`);
  } catch(error) {
    console.error("カード表示処理エラー:", error);
  }
}

// イベントリスナーとService Worker登録
searchBox.addEventListener('input', displayCards);
document.getElementById('refresh-btn').addEventListener('click', displayCards); // ボタンのイベントリスナー

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
