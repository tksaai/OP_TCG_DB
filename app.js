// app.js (JSONP対応・エラーログ強化・省略なし完全版)

// ▼▼▼【最重要】GASを再デプロイして取得した、あなたのウェブアプリURLに必ず置き換えてください ▼▼▼
const CARD_API_URL = 'https://script.google.com/macros/s/AKfycbyOqEM2gXAVpDJcp2QtOwPXrCCbhoh6FlZk1ITn0EWl6bwI0wTPN2cv2GaB_yf1Dit_/exec';

// IndexedDBの準備
const db = new Dexie('OnePieceCardDB');
// DBのバージョンを上げます。これにより、古いデータ構造を持つDBが自動的に削除され、再構築されます。
db.version(3).stores({
  cards: 'cardNumber, cardName, *color, *features, effectText',
  meta: 'key'
});

const statusMessageElement = document.getElementById('status-message');
const cardListElement = document.getElementById('card-list');
const searchBox = document.getElementById('search-box');


// app.js のこの関数を置き換えてください

/**
 * JSONPリクエストを実行する関数 (レスポンスの先頭にundefinedが付く問題に対応)
 * @param {string} url - リクエスト先のURL
 * @returns {Promise<any>} - サーバーからのJSONデータを解決するPromise
 */
function jsonpRequest(url) {
  return new Promise((resolve, reject) => {
    const callbackName = 'jsonp_callback_' + Math.round(100000 * Math.random());
    
    window[callbackName] = function(data) {
      // こちらは正常に呼ばれた場合の処理
      resolve(data);
    };

    const script = document.createElement('script');
    const fullUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + callbackName;
    
    // fetchを使ってテキストとして取得し、手動でパースする
    fetch(fullUrl)
      .then(response => {
        if (!response.ok) {
          throw new Error(`Network response was not ok: ${response.statusText}`);
        }
        return response.text();
      })
      .then(text => {
        // "undefined(" で始まり ")" で終わる部分を探す
        const match = text.match(/^undefined\((.*)\)$/);
        if (match && match[1]) {
          try {
            const jsonData = JSON.parse(match[1]);
            resolve(jsonData);
          } catch (e) {
            reject(new Error('Failed to parse JSON from response.'));
          }
        } else {
          // 通常のJSONPレスポンスの場合 (2回目以降の呼び出し)
          try {
             // 応答テキストから関数呼び出し部分を抽出し、JSON部分だけを取り出す
             const jsonString = text.substring(text.indexOf('(') + 1, text.lastIndexOf(')'));
             const jsonData = JSON.parse(jsonString);
             resolve(jsonData);
          } catch(e) {
             reject(new Error('Failed to parse standard JSONP response.'));
          }
        }
      })
      .catch(error => {
        reject(error);
      });
  });
}

/**
 * アプリのメイン初期化処理
 */
async function initializeApp() {
  try {
    const initialSyncDone = await db.meta.get('initialSyncDone');
    
    if (!initialSyncDone) {
      // --- 初回起動 ---
      await syncFullData();
    } else {
      // --- 2回目以降 ---
      // まずローカルデータで即時表示
      await displayCards(); 
      // バックグラウンドで差分更新 (エラーが出てもメイン処理は止めない)
      syncDifferentialData().catch(error => {
        console.warn("差分更新に失敗しました（オフラインまたはAPIエラー）:", error.message);
      });
    }
  } catch (error) {
    console.error("【重大なエラー】アプリケーションの初期化に失敗しました。");
    console.error("エラーの種類:", error.name);
    console.error("エラーメッセージ:", error.message);
    statusMessageElement.textContent = `初期化エラー: ${error.message}。オフラインで再試行します。`;
    // エラーが起きても、ローカルにデータがあれば表示を試みる
    await displayCards();
  } finally {
    statusMessageElement.style.display = 'none';
  }
}

/**
 * 全データを取得してDBを初期化する
 */
async function syncFullData() {
  statusMessageElement.textContent = '初回データ取得中...（数分かかる場合があります）';
  console.log('初回データ取得を開始します...');
  
  const allCards = await jsonpRequest(CARD_API_URL);

  if (allCards.error) {
    throw new Error(`APIエラー: ${allCards.message}`);
  }
  
  console.log(`APIから ${allCards.length} 件のカードデータを取得しました。`);
  await db.cards.clear();
  await db.cards.bulkAdd(allCards);
  await db.meta.put({ key: 'initialSyncDone', value: true });
  console.log('初回データ同期が完了しました。');
}

/**
 * 差分データ（新しいPカード）を取得してDBを更新する
 */
async function syncDifferentialData() {
    console.log('Pカードの差分更新をチェックします...');
    const knownPCards = await db.cards.where('cardNumber').startsWith('P-').primaryKeys();
    
    const requestUrl = `${CARD_API_URL}?knownPCards=${knownPCards.join(',')}`;
    
    const newCards = await jsonpRequest(requestUrl);

    if (newCards.error) {
      throw new Error(`APIエラー: ${newCards.message}`);
    }

    if (newCards.length > 0) {
      console.log(`${newCards.length} 件の新しいカードが見つかりました。DBを更新します。`);
      await db.cards.bulkAdd(newCards);
      await displayCards(); // 新データを反映して再表示
    } else {
      console.log('新しいカードはありませんでした。');
    }
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
    
    cardListElement.innerHTML = '';
    filteredCards.forEach(card => {
      const cardDiv = document.createElement('div');
      cardDiv.className = 'card-item';
      
      const imageUrl = card.imageUrlSmall || 'https://via.placeholder.com/100x140?text=No+Image';

      cardDiv.innerHTML = `<img src="${imageUrl}" alt="${card.cardName}" loading="lazy">`;
      
      cardListElement.appendChild(cardDiv);
    });
  } catch(error) {
    console.error("カード表示処理中にエラーが発生しました:", error);
  }
}

// イベントリスナーとService Worker登録
searchBox.addEventListener('input', displayCards);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').then(reg => {
      console.log('ServiceWorkerが登録されました。');
    }).catch(err => {
      console.error('ServiceWorkerの登録に失敗しました:', err);
    });
  });
}

// アプリケーション開始
initializeApp();

