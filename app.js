// app.js (JSON事前生成方式に対応した最終完成版・省略なし)

// ▼▼▼【最重要】GASを再デプロイして取得した、あなたの新しいウェブアプリURLに必ず置き換えてください ▼▼▼
const CARD_API_URL = 'https://script.google.com/macros/s/AKfycbyOqEM2gXAVpDJcp2QtOwPXrCCbhoh6FlZk1ITn0EWl6bwI0wTPN2cv2GaB_yf1Dit_/exec';

// IndexedDBの準備
const db = new Dexie('OnePieceCardDB');

// ▼▼▼ DBバージョンを上げ、主キーをGASで生成する 'uniqueId' に変更 ▼▼▼
db.version(5).stores({
  cards: 'uniqueId, cardNumber, cardName, *color, *features, effectText',
  meta: 'key' // metaストアはそのまま
});

const statusMessageElement = document.getElementById('status-message');
const cardListElement = document.getElementById('card-list');
const searchBox = document.getElementById('search-box');


/**
 * JSONPリクエストを実行する関数
 * @param {string} url - リクエスト先のURL
 * @returns {Promise<any>} - サーバーからのJSONデータを解決するPromise
 */
function jsonpRequest(url) {
  return new Promise((resolve, reject) => {
    // 毎回ユニークなコールバック関数名を生成
    const callbackName = 'jsonp_callback_' + Date.now() + Math.round(Math.random() * 1000);
    
    // グローバルスコープにコールバック関数を定義
    window[callbackName] = function(data) {
      // 成功したら後片付け
      clearTimeout(timeoutId);
      delete window[callbackName];
      if (document.body.contains(script)) {
        document.body.removeChild(script);
      }
      resolve(data);
    };

    // タイムアウト処理 (2分でタイムアウト)
    const timeoutId = setTimeout(() => {
        delete window[callbackName];
        if (document.body.contains(script)) {
            document.body.removeChild(script);
        }
        reject(new Error('JSONP request timed out after 120 seconds.'));
    }, 120000);

    // scriptタグを生成してリクエストを開始
    const script = document.createElement('script');
    script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + callbackName;
    script.onerror = (err) => {
        clearTimeout(timeoutId);
        delete window[callbackName];
        if (document.body.contains(script)) {
            document.body.removeChild(script);
        }
        reject(new Error('JSONP script loading error.'));
    };

    document.body.appendChild(script);
  });
}

/**
 * アプリのメイン初期化処理
 */
async function initializeApp() {
  try {
    // まずローカルのDBにデータがあればそれを表示して高速起動
    await displayCards();
    
    // その後、バックグラウンドで最新のデータをAPIから取得してDBを更新
    await syncData();
  } catch (error) {
    console.error("【重大なエラー】初期化またはデータ同期に失敗しました:", error);
    statusMessageElement.textContent = `エラー: ${error.message}。オフラインデータで表示します。`;
    // エラーが起きても、ローカルにデータがあれば表示を試みる
    await displayCards();
  } finally {
    // 正常に表示されたらローディングメッセージを隠す
    if (await db.cards.count() > 0) {
        statusMessageElement.style.display = 'none';
    } else {
        statusMessageElement.textContent = 'カードデータがありません。オンラインで再度お試しください。';
    }
  }
}

/**
 * APIから全データを取得し、ローカルDBを更新する
 */
async function syncData() {
  statusMessageElement.textContent = '最新データを取得中...';
  console.log('APIから全件データを取得します...');
  
  const allCards = await jsonpRequest(CARD_API_URL);

  if (allCards.error) {
    throw new Error(`APIエラー: ${allCards.message}`);
  }
  
  console.log(`APIから ${allCards.length} 件取得しました。`);
  // トランザクション内でクリアと一括追加を行う
  await db.transaction('rw', db.cards, async () => {
    await db.cards.clear();
    await db.cards.bulkAdd(allCards);
  });
  
  console.log('ローカルデータベースを更新しました。');
  // 更新が完了したら画面を再描画
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
        const targetText = [
          card.cardName,
          card.effectText,
          ...(Array.isArray(card.features) ? card.features : [])
        ].join(' ').toLowerCase();
        return searchWords.every(word => targetText.includes(word));
      });
    }

    const filteredCards = await collection.toArray();
    
    if (filteredCards.length === 0 && !searchTerm) {
        statusMessageElement.textContent = 'カードデータがありません。初回起動時はオンライン環境が必要です。';
        statusMessageElement.style.display = 'block';
    } else {
        statusMessageElement.style.display = 'none';
    }

    cardListElement.innerHTML = '';
    const fragment = document.createDocumentFragment();
    filteredCards.forEach(card => {
      const cardDiv = document.createElement('div');
      cardDiv.className = 'card-item';
      
      const imageUrl = card.imageUrlSmall || ''; // 画像URLがない場合は空文字

      // onerrorで代替画像やスタイルを指定することも可能
      cardDiv.innerHTML = `<img src="${imageUrl}" alt="${card.cardName}" loading="lazy" onerror="this.style.display='none'">`;
      
      fragment.appendChild(cardDiv);
    });
    cardListElement.appendChild(fragment);

  } catch(error) {
    console.error("カード表示処理中にエラーが発生しました:", error);
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
