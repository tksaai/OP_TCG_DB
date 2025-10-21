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

async function initializeApp() {
  try {
    // まずローカルDBのデータを表示（あれば）
    await displayCards();

    // その後、必ずバックグラウンドで最新データを取得・更新する
    await syncData();
    
  } catch (error) {
    console.error("【重大なエラー】初期化またはデータ同期に失敗:", error);
    statusMessageElement.textContent = `エラー: ${error.message}。オフラインデータで表示しています。`;
  }
}

async function syncData() {
  statusMessageElement.textContent = '最新データを取得中...';
  statusMessageElement.style.display = 'block';
  console.log('APIから全件データを取得します...');
  
  const allCards = await jsonpRequest(CARD_API_URL);
  if (allCards.error) throw new Error(`APIエラー: ${allCards.message}`);
  
  console.log(`APIから ${allCards.length} 件取得しました。`);
  
  await db.transaction('rw', db.cards, async () => {
    await db.cards.clear();
    await db.cards.bulkAdd(allCards);
  });
  
  console.log('ローカルデータベースを更新しました。');
  // ★★★ データ更新後に、再度displayCardsを呼び出す ★★★
  await displayCards(); 
  statusMessageElement.style.display = 'none';
}

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
    } else {
        statusMessageElement.style.display = 'none';
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
    console.log(`${filteredCards.length}件のカードを表示しました。`);
  } catch(error) {
    console.error("カード表示処理エラー:", error);
  }
}

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

initializeApp();
