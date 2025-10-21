// app.js (最終修正版)

// ▼▼▼【重要】GASを再デプロイして取得した、あなたのウェブアプリURLに必ず置き換えてください ▼▼▼
const CARD_API_URL = 'https://script.google.com/macros/s/AKfycbz52k9T2aUVI5IBoNB2waO9mhtcH7YAsMgRg4R2-3ZxfOtkp1mLl6hTemIA9LNZvZWe/exec';

// IndexedDBの準備
const db = new Dexie('OnePieceCardDB');
// DBのバージョンを上げます。これにより、古いデータ構造（画像IDマップなど）を持つDBが自動的に削除され、再構築されます。
db.version(2).stores({
  cards: 'cardNumber, cardName, *color, *features, effectText',
  meta: 'key'
});

const statusMessageElement = document.getElementById('status-message');
const cardListElement = document.getElementById('card-list');
const searchBox = document.getElementById('search-box');

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
    console.error("【重大なエラー】アプリケーションの初期化に失敗しました:", error);
    statusMessageElement.textContent = `エラー: ${error.message}。オフラインで起動します。`;
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
  
  const response = await fetch(CARD_API_URL);

  if (!response.ok) {
    throw new Error(`APIへの接続に失敗しました。ステータス: ${response.status}`);
  }

  const allCards = await response.json();
  if (allCards.error) { // GAS側でエラーが発生した場合
    throw new Error(`APIエラー: ${allCards.error}`);
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
    
    const response = await fetch(requestUrl);
    if (!response.ok) {
        throw new Error(`差分更新APIへの接続に失敗しました。ステータス: ${response.status}`);
    }

    const newCards = await response.json();
    if (newCards.error) {
      throw new Error(`APIエラー: ${newCards.error}`);
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
      
      // GASから渡された正しいURLをそのまま使用するだけ
      const imageUrl = card.imageUrlSmall || 'https://via.placeholder.com/100x140?text=No+Image'; // 画像URLがない場合の代替

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
