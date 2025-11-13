document.addEventListener('DOMContentLoaded', () => {
    // グローバル変数
    let allCards = [];
    let donCardId = 'ST01-017'; // ドン!!カードのID (必要に応じて変更)
    let deck = {
        leader: null,
        main: [], // { card: cardObject, count: number } の配列
        don: 0
    };

    // DOM要素
    const cardListEl = document.getElementById('card-list');
    const searchBarEl = document.getElementById('search-bar');
    const filterButtonEl = document.getElementById('filter-button');
    const resetButtonEl = document.getElementById('reset-button');
    const modalEl = document.getElementById('filter-modal');
    const closeModalEl = document.getElementById('close-modal');
    const applyFiltersEl = document.getElementById('apply-filters');
    const resetFiltersEl = document.getElementById('reset-filters');
    const loadingIndicatorEl = document.getElementById('loading-indicator');
    const imageModalEl = document.getElementById('image-modal');
    const modalImageEl = document.getElementById('modal-image');
    const closeImageModalEl = document.getElementById('close-image-modal');

    // デッキ構築関連 DOM
    const leaderCardAreaEl = document.getElementById('leader-card-area');
    const mainDeckAreaEl = document.getElementById('main-deck-area');
    const donDeckAreaEl = document.getElementById('don-deck-area');
    const leaderCountEl = document.getElementById('leader-count');
    const mainDeckCountEl = document.getElementById('main-deck-count');
    const donDeckCountEl = document.getElementById('don-deck-count');
    const clearDeckButtonEl = document.getElementById('clear-deck-button');
    const generateDeckCodeButtonEl = document.getElementById('generate-deck-code-button');
    const loadDeckCodeButtonEl = document.getElementById('load-deck-code-button');
    const deckCodeTextareaEl = document.getElementById('deck-code-textarea');
    const deckMessageEl = document.getElementById('deck-message');

    // カードデータをIndexedDBから読み込むか、フェッチする
    const cardStore = localforage.createInstance({ name: "cardDB", storeName: "cards" });

    async function loadCards() {
        loadingIndicatorEl.style.display = 'block';
        cardListEl.innerHTML = ''; // 既存の表示をクリア

        try {
            // IndexedDBからカードデータを試みる
            let cachedCards = await cardStore.getItem('allCards');
            
            if (cachedCards) {
                console.log('Using cached cards from IndexedDB');
                allCards = cachedCards;
            } else {
                console.log('Fetching cards from cards.json');
                const response = await fetch('cards.json');
                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }
                allCards = await response.json();
                // フェッチしたデータをIndexedDBに保存
                await cardStore.setItem('allCards', allCards);
                console.log('Cards saved to IndexedDB');
            }
            
            // ドン!!カードIDを動的に検索 (ST01-017以外の場合に備える)
            const donCard = allCards.find(card => card.Category === 'DON!!');
            if (donCard) {
                donCardId = donCard.CardNum;
            }

            displayCards(allCards);
            loadDeck(); // 保存されたデッキを読み込む
            updateDeckView(); // デッキ表示を更新
        } catch (error) {
            console.error('カードの読み込みに失敗しました:', error);
            cardListEl.innerHTML = '<p>カードの読み込みに失敗しました。リロードしてください。</p>';
        } finally {
            loadingIndicatorEl.style.display = 'none';
        }
    }

    // カードリストの表示
    function displayCards(cards) {
        cardListEl.innerHTML = '';
        if (cards.length === 0) {
            cardListEl.innerHTML = '<p>該当するカードがありません。</p>';
            return;
        }

        const fragment = document.createDocumentFragment();
        cards.forEach(card => {
            const cardItem = document.createElement('div');
            cardItem.className = 'card-item';
            
            const cardImage = document.createElement('img');
            cardImage.src = card.ImgSrc;
            cardImage.alt = card.CardName;
            cardImage.loading = 'lazy'; // 遅延読み込み
            
            // 画像クリックでモーダル表示
            cardImage.addEventListener('click', () => openImageModal(card.ImgSrc));

            // デッキ追加ボタン
            const addButton = document.createElement('button');
            addButton.className = 'add-card-button';
            addButton.textContent = '+';
            addButton.title = 'デッキに追加';
            addButton.addEventListener('click', (e) => {
                e.stopPropagation(); // 画像クリックイベントの発火を防ぐ
                addCardToDeck(card);
            });
            
            cardItem.appendChild(cardImage);
            cardItem.appendChild(addButton);
            fragment.appendChild(cardItem);
        });
        cardListEl.appendChild(fragment);
    }

    // 検索とフィルターの実行
    function performSearchAndFilter() {
        const searchTerm = searchBarEl.value.toLowerCase();
        
        // フィルターモーダルから選択された値を取得
        const selectedColors = getCheckedValues('.color-filters input');
        const selectedCardTypes = getCheckedValues('.type-filters input');
        const selectedCosts = getCheckedValues('.cost-filters input');
        const selectedPowers = getCheckedValues('.power-filters input');
        const selectedCounters = getCheckedValues('.counter-filters input');
        const selectedAbilities = getCheckedValues('.ability-filters input');
        const selectedAttributes = getCheckedValues('.attribute-filters input');
        const selectedBlockIcons = getCheckedValues('.blockicon-filters input');

        const filteredCards = allCards.filter(card => {
            // 検索語
            const nameMatch = card.CardName.toLowerCase().includes(searchTerm) || card.CardNum.toLowerCase().includes(searchTerm);
            
            // 色 (AND検索: チェックされた色をすべて含む)
            const colorMatch = selectedColors.length === 0 || selectedColors.every(color => card.Color.includes(color));
            
            // カードタイプ
            const typeMatch = selectedCardTypes.length === 0 || selectedCardTypes.includes(card.Category);
            
            // コスト
            const costMatch = selectedCosts.length === 0 || selectedCosts.includes(card.Cost || null); // nullも考慮

            // パワー
            const powerMatch = selectedPowers.length === 0 || selectedPowers.includes(card.Power || null);
            
            // カウンター
            const counterMatch = selectedCounters.length === 0 || selectedCounters.includes(card.Counter || '-'); // "なし" は "-" とマッピング
            
            // 属性 (OR検索: チェックされた属性のいずれかを含む)
            const attributeMatch = selectedAttributes.length === 0 || selectedAttributes.some(attr => card.Attribute && card.Attribute.includes(attr));

            // ブロックアイコン
            const blockIconMatch = selectedBlockIcons.length === 0 || selectedBlockIcons.includes(card.BlockIcon || null);

            // 能力
            let abilityMatch = true;
            if (selectedAbilities.length > 0) {
                abilityMatch = selectedAbilities.every(ability => {
                    if (ability === 'vanilla') {
                        return (card.Effect === null || card.Effect === "-") && (card.Trigger === null || card.Trigger === "-");
                    }
                    if (ability === 'blocker') {
                        return card.Effect && card.Effect.includes("【ブロッカー】");
                    }
                    if (ability === 'trigger') {
                        return card.Trigger && card.Trigger !== null && card.Trigger !== "-";
                    }
                    return true;
                });
            }

            return nameMatch && colorMatch && typeMatch && costMatch && powerMatch && counterMatch && attributeMatch && blockIconMatch && abilityMatch;
        });

        displayCards(filteredCards);
    }

    // チェックボックスのヘルパー関数
    function getCheckedValues(selector) {
        return Array.from(document.querySelectorAll(selector))
            .filter(input => input.checked)
            .map(input => input.value);
    }

    // フィルターリセット
    function resetFilters() {
        document.querySelectorAll('.filter-options input').forEach(input => input.checked = false);
        performSearchAndFilter();
    }

    // --- デッキ構築ロジック ---

    // デッキにカードを追加
    function addCardToDeck(card) {
        showDeckMessage(''); // メッセージをクリア

        if (card.Category === 'Leader') {
            if (deck.leader) {
                showDeckMessage('リーダーは既に設定されています。', 'error');
                return;
            }
            deck.leader = card;
        } else if (card.Category === 'DON!!') {
            if (deck.don >= 10) {
                showDeckMessage('ドン!!デッキは10枚までです。', 'error');
                return;
            }
            deck.don++;
        } else if (['Character', 'Event', 'Stage'].includes(card.Category)) {
            const mainDeckTotal = deck.main.reduce((sum, item) => sum + item.count, 0);
            if (mainDeckTotal >= 50) {
                showDeckMessage('メインデッキは50枚までです。', 'error');
                return;
            }
            
            const existingCard = deck.main.find(item => item.card.CardNum === card.CardNum);
            if (existingCard) {
                if (existingCard.count >= 4) {
                    showDeckMessage(`カード「${card.CardName}」は4枚までしか入れられません。`, 'error');
                    return;
                }
                existingCard.count++;
            } else {
                deck.main.push({ card: card, count: 1 });
            }
        } else {
            showDeckMessage('このカードタイプはデッキに追加できません。', 'error');
            return;
        }

        saveDeck();
        updateDeckView();
    }

    // デッキからカードを削除
    function removeCardFromDeck(cardNum, category) {
        showDeckMessage(''); // メッセージをクリア

        if (category === 'Leader') {
            if (deck.leader && deck.leader.CardNum === cardNum) {
                deck.leader = null;
            }
        } else if (category === 'DON!!') {
            if (deck.don > 0) {
                deck.don--;
            }
        } else if (category === 'Main') {
            const cardIndex = deck.main.findIndex(item => item.card.CardNum === cardNum);
            if (cardIndex > -1) {
                deck.main[cardIndex].count--;
                if (deck.main[cardIndex].count <= 0) {
                    deck.main.splice(cardIndex, 1);
                }
            }
        }

        saveDeck();
        updateDeckView();
    }

    // デッキ表示の更新
    function updateDeckView() {
        // リーダー
        leaderCardAreaEl.innerHTML = '';
        if (deck.leader) {
            const leaderImg = document.createElement('img');
            leaderImg.src = deck.leader.ImgSrc;
            leaderImg.alt = deck.leader.CardName;
            leaderImg.className = 'leader-card-image';
            leaderImg.title = 'クリックして削除';
            leaderImg.addEventListener('click', () => removeCardFromDeck(deck.leader.CardNum, 'Leader'));
            leaderCardAreaEl.appendChild(leaderImg);
        } else {
            leaderCardAreaEl.innerHTML = '<p>リーダーを追加してください</p>';
        }
        leaderCountEl.textContent = `(${deck.leader ? 1 : 0}/1)`;

        // メインデッキ
        mainDeckAreaEl.innerHTML = '';
        deck.main.sort((a, b) => a.card.Cost - b.card.Cost || a.card.CardName.localeCompare(b.card.CardName)); // コスト順、名前順ソート
        
        let mainDeckTotal = 0;
        if (deck.main.length > 0) {
            deck.main.forEach(item => {
                mainDeckTotal += item.count;
                const itemEl = document.createElement('div');
                itemEl.className = 'deck-card-item';
                
                itemEl.innerHTML = `
                    <span class="deck-card-name" title="${item.card.CardName} (コスト: ${item.card.Cost})">
                        ${item.card.CardName}
                    </span>
                    <div class="deck-card-controls">
                        <span class="deck-card-count">x${item.count}</span>
                        <button class="deck-remove-button" data-cardnum="${item.card.CardNum}" data-category="Main" title="1枚削除">-</button>
                    </div>
                `;
                mainDeckAreaEl.appendChild(itemEl);
            });
        } else {
            mainDeckAreaEl.innerHTML = '<p>メインデッキ (50枚)</p>';
        }
        mainDeckCountEl.textContent = `(${mainDeckTotal}/50)`;
        mainDeckCountEl.style.color = mainDeckTotal === 50 ? 'green' : 'inherit';


        // ドン!!デッキ
        donDeckAreaEl.innerHTML = '';
        if (deck.don > 0) {
            const donCard = allCards.find(c => c.CardNum === donCardId);
            const donName = donCard ? donCard.CardName : 'ドン!!';
            const donImgSrc = donCard ? donCard.ImgSrc : 'icons/iconx192.png'; // フォールバック画像

            const itemEl = document.createElement('div');
            itemEl.className = 'deck-don-item';
            
            itemEl.innerHTML = `
                <img src="${donImgSrc}" alt="ドン!!" style="width: 30px; height: auto; margin-right: 5px;">
                <span class="deck-card-name">${donName}</span>
                <div class="deck-card-controls">
                    <span class="deck-card-count">x${deck.don}</span>
                    <button class="deck-remove-button" data-cardnum="${donCardId}" data-category="DON!!" title="1枚削除">-</button>
                </div>
            `;
            donDeckAreaEl.appendChild(itemEl);

        } else {
            donDeckAreaEl.innerHTML = '<p>ドン!!デッキ (10枚)</p>';
        }
        donDeckCountEl.textContent = `(${deck.don}/10)`;
        donDeckCountEl.style.color = deck.don === 10 ? 'green' : 'inherit';

        // 削除ボタンのイベントリスナーを（再）設定
        document.querySelectorAll('.deck-remove-button').forEach(button => {
            button.addEventListener('click', () => {
                removeCardFromDeck(button.dataset.cardnum, button.dataset.category);
            });
        });
    }

    // デッキをクリア
    function clearDeck() {
        deck = { leader: null, main: [], don: 0 };
        saveDeck();
        updateDeckView();
        showDeckMessage('デッキをクリアしました。', 'success');
    }

    // デッキコード発行
    function generateDeckCode() {
        if (!deck.leader) {
            showDeckMessage('リーダーカードが設定されていません。', 'error');
            return;
        }

        try {
            const leaderCode = deck.leader.CardNum;
            const mainCode = deck.main
                .map(item => `${item.card.CardNum}*${item.count}`)
                .join('_');
            const donCode = deck.don; // ドンは枚数だけ

            const deckString = `L:${leaderCode};M:${mainCode};D:${donCode}`;
            
            // Base64エンコード
            const encodedCode = btoa(unescape(encodeURIComponent(deckString))); // UTF-8対応
            
            deckCodeTextareaEl.value = encodedCode;
            showDeckMessage('デッキコードを発行しました。', 'success');
        } catch (e) {
            console.error('Deck code generation failed:', e);
            showDeckMessage('デッキコードの発行に失敗しました。', 'error');
        }
    }

    // デッキコード読み込み
    function loadDeckFromCode() {
        const encodedCode = deckCodeTextareaEl.value.trim();
        if (!encodedCode) {
            showDeckMessage('デッキコードを入力してください。', 'error');
            return;
        }

        try {
            // Base64デコード
            const deckString = decodeURIComponent(escape(atob(encodedCode))); // UTF-8対応

            const newDeck = { leader: null, main: [], don: 0 };

            const parts = deckString.split(';');
            parts.forEach(part => {
                const [key, value] = part.split(':');
                if (key === 'L') {
                    // リーダー
                    const leaderCard = allCards.find(c => c.CardNum === value);
                    if (leaderCard) {
                        newDeck.leader = leaderCard;
                    } else {
                        throw new Error(`リーダーカードが見つかりません: ${value}`);
                    }
                } else if (key === 'M') {
                    // メインデッキ
                    if (value) {
                        const mainCards = value.split('_');
                        mainCards.forEach(cardStr => {
                            const [cardNum, countStr] = cardStr.split('*');
                            const count = parseInt(countStr, 10);
                            const card = allCards.find(c => c.CardNum === cardNum);
                            if (card && count > 0) {
                                newDeck.main.push({ card: card, count: count });
                            } else if (card) {
                                console.warn(`Invalid count for ${cardNum}: ${countStr}`);
                            } else {
                                console.warn(`Card not found in DB: ${cardNum}`);
                            }
                        });
                    }
                } else if (key === 'D') {
                    // ドン!!
                    newDeck.don = parseInt(value, 10) || 0;
                }
            });

            if (!newDeck.leader) {
                throw new Error('デッキコードにリーダーが含まれていません。');
            }

            deck = newDeck;
            saveDeck();
            updateDeckView();
            showDeckMessage('デッキを読み込みました。', 'success');

        } catch (e) {
            console.error('Deck code loading failed:', e);
            showDeckMessage(`デッキコードの読み込みに失敗しました: ${e.message}`, 'error');
        }
    }

    // デッキメッセージ表示
    function showDeckMessage(message, type = 'info') {
        deckMessageEl.textContent = message;
        deckMessageEl.className = `deck-message ${type}`;
        
        // 3秒後にメッセージを消す
        setTimeout(() => {
            if (deckMessageEl.textContent === message) {
                deckMessageEl.textContent = '';
                deckMessageEl.className = 'deck-message';
            }
        }, 3000);
    }

    // デッキをlocalStorageに保存
    function saveDeck() {
        // localStorage用に軽量化
        const savableDeck = {
            leader: deck.leader ? deck.leader.CardNum : null,
            main: deck.main.map(item => ({ id: item.card.CardNum, count: item.count })),
            don: deck.don
        };
        localStorage.setItem('opTcgDeck', JSON.stringify(savableDeck));
    }

    // localStorageからデッキを読み込み
    function loadDeck() {
        const savedDeck = localStorage.getItem('opTcgDeck');
        if (!savedDeck || allCards.length === 0) {
            return;
        }

        try {
            const parsedDeck = JSON.parse(savedDeck);
            const newDeck = { leader: null, main: [], don: 0 };

            // リーダーを復元
            if (parsedDeck.leader) {
                newDeck.leader = allCards.find(c => c.CardNum === parsedDeck.leader) || null;
            }

            // メインデッキを復元
            if (parsedDeck.main) {
                parsedDeck.main.forEach(item => {
                    const card = allCards.find(c => c.CardNum === item.id);
                    if (card) {
                        newDeck.main.push({ card: card, count: item.count });
                    }
                });
            }

            // ドン!!を復元
            newDeck.don = parsedDeck.don || 0;

            deck = newDeck;
            // updateDeckView() は loadCards の最後で呼ばれる

        } catch(e) {
            console.error('Failed to load deck from localStorage:', e);
            localStorage.removeItem('opTcgDeck'); // 壊れたデータを削除
        }
    }


    // --- 画像モーダル ---
    function openImageModal(src) {
        modalImageEl.src = src;
        imageModalEl.style.display = 'block';
    }

    function closeImageModal() {
        imageModalEl.style.display = 'none';
    }

    // --- イベントリスナー設定 ---
    
    // 検索バー (入力ごとに検索)
    searchBarEl.addEventListener('input', performSearchAndFilter);

    // フィルターボタン
    filterButtonEl.addEventListener('click', () => modalEl.style.display = 'block');
    closeModalEl.addEventListener('click', () => modalEl.style.display = 'none');
    applyFiltersEl.addEventListener('click', () => {
        performSearchAndFilter();
        modalEl.style.display = 'none';
    });
    resetFiltersEl.addEventListener('click', resetFilters);

    // グローバルリセットボタン
    resetButtonEl.addEventListener('click', () => {
        searchBarEl.value = '';
        resetFilters();
    });

    // モーダル外クリックで閉じる
    window.addEventListener('click', (event) => {
        if (event.target === modalEl) {
            modalEl.style.display = 'none';
        }
        if (event.target === imageModalEl) {
            closeImageModal();
        }
    });

    // 画像モーダル閉じる
    closeImageModalEl.addEventListener('click', closeImageModal);

    // デッキ構築ボタン
    clearDeckButtonEl.addEventListener('click', clearDeck);
    generateDeckCodeButtonEl.addEventListener('click', generateDeckCode);
    loadDeckCodeButtonEl.addEventListener('click', loadDeckFromCode);

    // PWAサービスワーカー登録
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/service-worker.js')
                .then(registration => {
                    console.log('ServiceWorker registration successful with scope: ', registration.scope);
                })
                .catch(err => {
                    console.log('ServiceWorker registration failed: ', err);
                });
        });
    }

    // アプリケーション開始
    loadCards();
});