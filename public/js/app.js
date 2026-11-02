/**
 * Battleships Command Center - Client Application
 */

const FLEET_DEFINITIONS = [
    { id: 'carrier', name: 'Aircraft Carrier', size: 5 },
    { id: 'battleship', name: 'Battleship', size: 4 },
    { id: 'cruiser', name: 'Cruiser', size: 3 },
    { id: 'submarine', name: 'Submarine', size: 3 },
    { id: 'destroyer', name: 'Destroyer', size: 2 }
];

class BattleshipApp {
    constructor() {
        this.currentPlayer = null;
        this.activeGameId = null;
        this.gameState = null;
        this.eventSource = null;
        this.pollInterval = null;

        // Mobile Board Tab: 'radar' or 'fleet'
        this.mobileActiveBoard = 'radar';

        // Placement State
        this.placementOrientation = 'H'; // 'H' or 'V'
        this.selectedShipId = 'carrier';
        this.placedShips = []; // [{ id, name, size, cells: [{r, c}] }]

        this.init();
    }

    async init() {
        this.bindEvents();
        this.updateAudioButton();
        await this.loadPlayers();

        // Restore saved session if exists
        const savedPlayerId = localStorage.getItem('battleships_player_id');
        const savedPlayerName = localStorage.getItem('battleships_player_name');
        if (savedPlayerId && savedPlayerName) {
            this.setPlayer({ id: savedPlayerId, name: savedPlayerName });
        }

        const savedGameId = localStorage.getItem('battleships_active_game_id');
        if (savedGameId && this.currentPlayer) {
            this.resumeGame(savedGameId);
        } else {
            this.showScreen('lobby');
        }
    }

    bindEvents() {
        // Audio Toggle
        document.getElementById('btn-mute').addEventListener('click', () => {
            const muted = window.soundEngine.toggleMute();
            this.updateAudioButton();
        });

        // Switch Commander Button
        document.getElementById('btn-switch-player').addEventListener('click', () => {
            this.clearPlayer();
        });

        // Player Select & Register
        document.getElementById('btn-select-player').addEventListener('click', () => this.handleSelectPlayer());
        document.getElementById('btn-register-player').addEventListener('click', () => this.handleRegisterPlayer());

        // Quick Launch & Custom Launch
        document.getElementById('btn-quick-launch').addEventListener('click', () => this.handleCreateGame());
        document.getElementById('btn-create-custom-game').addEventListener('click', () => {
            const name = document.getElementById('custom-game-input').value.trim();
            this.handleCreateGame(name);
        });

        // Save & Exit to HQ
        document.getElementById('btn-save-exit-placement').addEventListener('click', () => this.saveAndExitGame());
        document.getElementById('btn-save-exit-combat').addEventListener('click', () => this.saveAndExitGame());

        // Cancel Battle
        document.getElementById('btn-cancel-game-placement').addEventListener('click', () => this.cancelActiveGame());
        document.getElementById('btn-cancel-game-combat').addEventListener('click', () => this.cancelActiveGame());

        // Placement controls
        document.getElementById('btn-toggle-orientation').addEventListener('click', () => this.toggleOrientation());
        document.getElementById('btn-randomize-placement').addEventListener('click', () => this.handleRandomizePlacement());
        document.getElementById('btn-reset-placement').addEventListener('click', () => this.resetPlacement());
        document.getElementById('btn-ready-placement').addEventListener('click', () => this.submitPlacement());

        // Modal Controls
        document.getElementById('btn-modal-lobby').addEventListener('click', () => {
            this.closeModal();
            this.leaveActiveGame();
        });
        document.getElementById('btn-modal-rematch').addEventListener('click', () => {
            this.closeModal();
            this.requestRematch();
        });

        // Keyboard shortcuts: 'R' to rotate ship during placement
        window.addEventListener('keydown', (e) => {
            if (e.key === 'r' || e.key === 'R') {
                if (document.getElementById('view-placement').classList.contains('active')) {
                    this.toggleOrientation();
                }
            }
        });
    }

    updateAudioButton() {
        const btn = document.getElementById('btn-mute');
        const muted = window.soundEngine.isMuted();
        btn.innerHTML = muted ? '🔇 Sound: Off' : '🔊 Sound: On';
    }

    showScreen(name) {
        document.querySelectorAll('.view-screen').forEach(el => el.classList.remove('active'));
        const target = document.getElementById(`view-${name}`);
        if (target) target.classList.add('active');

        // Manage polling
        if (name === 'lobby') {
            this.startLobbyPolling();
            this.stopGameStream();
        } else {
            this.stopLobbyPolling();
        }
    }

    showToast(message) {
        const existing = document.querySelector('.toast-notice');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'toast-notice';
        toast.innerHTML = `<span>ℹ️</span> <span>${message}</span>`;
        document.body.appendChild(toast);

        setTimeout(() => {
            if (toast) toast.remove();
        }, 3200);
    }

    // =========================================================================
    // Player Authentication / Selection
    // =========================================================================

    async loadPlayers() {
        try {
            const res = await fetch('/api/players');
            const players = await res.json();
            const select = document.getElementById('player-select-dropdown');
            select.innerHTML = '<option value="">-- Choose Existing Commander --</option>';
            players.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.name;
                select.appendChild(opt);
            });
        } catch (e) {
            console.error('Failed to load players:', e);
        }
    }

    setPlayer(player) {
        this.currentPlayer = player;
        localStorage.setItem('battleships_player_id', player.id);
        localStorage.setItem('battleships_player_name', player.name);

        document.getElementById('current-player-name').textContent = player.name;
        document.getElementById('quick-player-name').textContent = player.name;

        document.getElementById('player-active-section').style.display = 'block';
        document.getElementById('player-logged-in-box').style.display = 'block';
        document.getElementById('player-auth-section').style.display = 'none';

        this.loadGames();
    }

    clearPlayer() {
        this.currentPlayer = null;
        localStorage.removeItem('battleships_player_id');
        localStorage.removeItem('battleships_player_name');
        localStorage.removeItem('battleships_active_game_id');

        document.getElementById('player-active-section').style.display = 'none';
        document.getElementById('player-logged-in-box').style.display = 'none';
        document.getElementById('player-auth-section').style.display = 'block';
        document.getElementById('pinned-my-battles-section').style.display = 'none';

        this.loadPlayers();
        this.showScreen('lobby');
    }

    handleSelectPlayer() {
        const select = document.getElementById('player-select-dropdown');
        const id = select.value;
        if (!id) {
            alert('Please select a commander from the dropdown list.');
            return;
        }
        const name = select.options[select.selectedIndex].text;
        this.setPlayer({ id, name });
        window.soundEngine.sonarPing();
    }

    async handleRegisterPlayer() {
        const input = document.getElementById('new-player-input');
        const name = input.value.trim();
        if (!name) {
            alert('Please enter a commander name.');
            return;
        }

        try {
            const res = await fetch('/api/players', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const data = await res.json();
            if (data.id) {
                this.setPlayer(data);
                input.value = '';
                window.soundEngine.sonarPing();
            } else {
                alert(data.error || 'Failed to register commander');
            }
        } catch (e) {
            alert('Error communicating with home server');
        }
    }

    // =========================================================================
    // Lobby & Games
    // =========================================================================

    startLobbyPolling() {
        this.stopLobbyPolling();
        this.loadGames();
        this.pollInterval = setInterval(() => this.loadGames(), 3000);
    }

    stopLobbyPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    async loadGames() {
        if (!this.currentPlayer) return;
        try {
            const res = await fetch('/api/games');
            const games = await res.json();
            this.renderGamesList(games);
        } catch (e) {
            console.error('Failed to load games:', e);
        }
    }

    renderGamesList(games) {
        const allList = document.getElementById('games-list-container');
        const pinnedSection = document.getElementById('pinned-my-battles-section');
        const pinnedList = document.getElementById('pinned-my-battles-list');

        if (!games || games.length === 0) {
            allList.innerHTML = '<div style="color:var(--text-muted); padding:1rem; text-align:center;">No battles active. Tap Quick Launch above to start one!</div>';
            pinnedSection.style.display = 'none';
            return;
        }

        const myActiveGames = games.filter(g =>
            (g.player1Id === this.currentPlayer.id || g.player2Id === this.currentPlayer.id) && g.phase !== 'finished'
        );

        // Render Pinned Active Games
        if (myActiveGames.length > 0) {
            pinnedSection.style.display = 'block';
            pinnedList.innerHTML = '';
            myActiveGames.forEach(g => {
                const item = this.createGameItemElement(g, true);
                pinnedList.appendChild(item);
            });
        } else {
            pinnedSection.style.display = 'none';
        }

        // Render All Open / Other Games
        allList.innerHTML = '';
        games.forEach(g => {
            const item = this.createGameItemElement(g, false);
            allList.appendChild(item);
        });
    }

    createGameItemElement(g, isPinned) {
        const isMyGame = (g.player1Id === this.currentPlayer.id || g.player2Id === this.currentPlayer.id);
        const canJoin = (!isMyGame && !g.player2Id && g.phase === 'waiting');

        let badgeClass = 'badge-waiting';
        let badgeText = 'Waiting for Opponent';
        if (g.phase === 'placement') {
            badgeClass = 'badge-placement';
            badgeText = 'Fleet Deployment';
        } else if (g.phase === 'playing') {
            badgeClass = 'badge-playing';
            badgeText = (g.currentTurnPlayerId === this.currentPlayer.id) ? '👉 YOUR TURN' : 'Active Battle';
        } else if (g.phase === 'finished') {
            badgeClass = 'badge-finished';
            badgeText = (g.winnerId === this.currentPlayer.id) ? '🏆 Victory' : 'Finished';
        }

        const p1 = g.player1Name || 'Commander 1';
        const p2 = g.player2Name || (g.phase === 'waiting' ? 'Open Seat' : 'Commander 2');

        const item = document.createElement('div');
        item.className = 'game-item';

        let buttons = '';
        if (isMyGame) {
            buttons = `
                <button class="btn btn-sm btn-success" onclick="app.resumeGame('${g.id}')">▶️ Resume</button>
                <button class="btn btn-sm btn-danger" onclick="app.cancelGame('${g.id}')" title="Cancel & Delete">❌ Cancel</button>
            `;
        } else if (canJoin) {
            buttons = `<button class="btn btn-sm" onclick="app.joinGame('${g.id}')">⚔️ Join Battle</button>`;
        } else {
            buttons = `<button class="btn btn-sm btn-secondary" onclick="app.resumeGame('${g.id}')">Spectate</button>`;
        }

        item.innerHTML = `
            <div class="game-item-info">
                <div class="game-item-name">${this.escape(g.name)}</div>
                <div class="game-item-players">👥 ${this.escape(p1)} vs ${this.escape(p2)}</div>
                <div><span class="game-badge ${badgeClass}">${badgeText}</span></div>
            </div>
            <div class="game-item-actions">${buttons}</div>
        `;
        return item;
    }

    async handleCreateGame(customName) {
        if (!this.currentPlayer) return;
        const name = customName || `${this.currentPlayer.name}'s Operation`;

        try {
            const res = await fetch('/api/games', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    playerId: this.currentPlayer.id,
                    name: name
                })
            });
            const data = await res.json();
            if (data.id) {
                window.soundEngine.sonarPing();
                this.resumeGame(data.id);
            } else {
                alert(data.error || 'Failed to create battle');
            }
        } catch (e) {
            alert('Error creating battle on home server');
        }
    }

    async joinGame(gameId) {
        if (!this.currentPlayer) return;
        try {
            const res = await fetch(`/api/games/${gameId}/join`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playerId: this.currentPlayer.id })
            });
            const data = await res.json();
            if (data.success) {
                window.soundEngine.sonarPing();
                this.resumeGame(gameId);
            } else {
                alert(data.error || 'Unable to join battle');
            }
        } catch (e) {
            alert('Error joining game');
        }
    }

    async cancelGame(gameId) {
        if (!this.currentPlayer) return;
        if (!confirm('Are you sure you want to cancel and delete this battle?')) return;

        try {
            const res = await fetch(`/api/games/${gameId}/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playerId: this.currentPlayer.id })
            });
            const data = await res.json();
            if (data.success) {
                this.showToast('Battle cancelled and removed.');
                if (this.activeGameId === gameId) {
                    this.leaveActiveGame();
                } else {
                    this.loadGames();
                }
            } else {
                alert(data.error || 'Failed to cancel battle');
            }
        } catch (e) {
            alert('Error communicating with home server');
        }
    }

    cancelActiveGame() {
        if (this.activeGameId) {
            this.cancelGame(this.activeGameId);
        }
    }

    saveAndExitGame() {
        this.showToast('Battle saved! You can resume anytime from the HQ.');
        this.leaveActiveGame();
    }

    // =========================================================================
    // Active Match Management & Stream
    // =========================================================================

    async resumeGame(gameId) {
        this.activeGameId = gameId;
        localStorage.setItem('battleships_active_game_id', gameId);

        await this.fetchGameState();
        this.startEventStream(gameId);
    }

    leaveActiveGame() {
        this.activeGameId = null;
        this.gameState = null;
        this.placedShips = [];
        localStorage.removeItem('battleships_active_game_id');
        this.stopGameStream();
        this.showScreen('lobby');
    }

    startEventStream(gameId) {
        this.stopGameStream();

        // Server-Sent Events (SSE)
        try {
            this.eventSource = new EventSource(`/api/stream?gameId=${gameId}`);
            
            const onUpdate = () => {
                this.fetchGameState();
            };

            this.eventSource.addEventListener('game_update', onUpdate);
            this.eventSource.onmessage = onUpdate;

            this.eventSource.addEventListener('game_cancelled', (e) => {
                alert('This battle was cancelled by the commander.');
                this.leaveActiveGame();
            });

            this.eventSource.onerror = () => {
                // Keep polling active
            };
        } catch (e) {
            console.warn('SSE not supported on this browser, relying on fast polling');
        }

        // Fast Polling Failsafe (1.5 seconds)
        // Ensures instant updates on mobile Safari / Chrome even if SSE is interrupted
        this.pollInterval = setInterval(() => {
            this.fetchGameState();
        }, 1500);
    }

    stopGameStream() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    async fetchGameState() {
        if (!this.activeGameId || !this.currentPlayer) return;
        try {
            const res = await fetch(`/api/games/${this.activeGameId}?playerId=${this.currentPlayer.id}`);
            if (!res.ok) {
                if (res.status === 404) {
                    this.leaveActiveGame();
                    return;
                }
            }
            const data = await res.json();
            const prevState = this.gameState;
            this.gameState = data;
            this.handleStateUpdate(prevState, data);
        } catch (e) {
            console.error('Error fetching game state:', e);
        }
    }

    handleStateUpdate(prev, cur) {
        document.getElementById('active-match-title').textContent = cur.name;
        document.getElementById('placement-match-heading').textContent = cur.name;

        // Phase 1: Waiting for Player 2
        if (cur.phase === 'waiting') {
            this.showScreen('placement');
            this.renderWaitingForP2Screen();
            return;
        }

        // Phase 2: Placement
        if (cur.phase === 'placement') {
            this.showScreen('placement');
            if (cur.myReady) {
                this.renderWaitingForOpponentPlacement();
            } else {
                this.renderPlacementEditor();
            }
            return;
        }

        // Phase 3: Active Playing or Finished
        if (cur.phase === 'playing' || cur.phase === 'finished') {
            this.showScreen('combat');
            this.renderCombatScreen(prev, cur);

            // Game finished modal
            if (cur.phase === 'finished' && (!prev || prev.phase !== 'finished')) {
                this.showGameOverModal(cur.winnerId === this.currentPlayer.id);
            }
        }
    }

    // =========================================================================
    // Placement Screen
    // =========================================================================

    renderWaitingForP2Screen() {
        const dock = document.getElementById('placement-dock-container');
        const joinUrl = window.location.origin;

        dock.innerHTML = `
            <div style="text-align:center; padding:1.5rem 1rem;">
                <div class="radar-sweep-animation"></div>
                <h3 style="color:var(--accent-cyan); margin-bottom:0.5rem; letter-spacing:0.05em;">WAITING FOR PLAYER 2</h3>
                <p style="color:var(--text-muted); font-size:0.9rem; max-width:440px; margin:0 auto 1.25rem auto;">
                    Have your opponent connect to your home Wi-Fi and open this URL on their device to join:
                </p>
                <div style="display:inline-flex; align-items:center; gap:0.5rem; background:var(--bg-dark); border:1px solid var(--accent-cyan); padding:0.5rem 1rem; border-radius:8px; margin-bottom:1.5rem; font-family:monospace; font-size:1rem; color:var(--accent-cyan);">
                    <span>${joinUrl}</span>
                    <button class="btn btn-sm btn-secondary" onclick="navigator.clipboard.writeText('${joinUrl}'); app.showToast('URL copied to clipboard!');">📋 Copy</button>
                </div>
                <div>
                    <button class="btn btn-danger btn-sm" onclick="app.cancelActiveGame()">❌ Cancel Operation</button>
                </div>
            </div>
        `;
        document.getElementById('placement-controls-row').style.display = 'none';
        document.getElementById('placement-board-container').innerHTML = '';
    }

    renderWaitingForOpponentPlacement() {
        const dock = document.getElementById('placement-dock-container');
        dock.innerHTML = `
            <div style="text-align:center; padding:1.5rem;">
                <div class="radar-sweep-animation"></div>
                <h3 style="color:var(--accent-green); margin-bottom:0.5rem; letter-spacing:0.05em;">FLEET ARMED AND LOCKED!</h3>
                <p style="color:var(--text-muted); font-size:0.9rem;">Waiting for enemy commander to deploy their ships...</p>
            </div>
        `;
        document.getElementById('placement-controls-row').style.display = 'none';
        this.renderPlacementBoard(false);
    }

    renderPlacementEditor() {
        const dock = document.getElementById('placement-dock-container');
        // Restore standard dock template if returning from waiting
        if (!document.getElementById('placement-dock-ships')) {
            dock.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem;">
                    <div>
                        <strong style="color: var(--accent-cyan); text-transform: uppercase;">Fleet Dock:</strong>
                        <span style="font-size: 0.82rem; color: var(--text-muted); margin-left: 0.5rem;">Tap a ship, then tap grid cell to place. Tap placed ship to remove.</span>
                    </div>
                    <button class="icon-btn" id="btn-toggle-orientation" style="font-weight: 700; color: var(--accent-cyan);" onclick="app.toggleOrientation()">
                        Orientation: ${this.placementOrientation === 'H' ? 'Horizontal ↔' : 'Vertical ↕'} (Press R)
                    </button>
                </div>
                <div class="dock-ships" id="placement-dock-ships"></div>
                <div id="placement-controls-row" style="display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 1rem; border-top: 1px solid var(--bg-panel-border); padding-top: 0.75rem;">
                    <button id="btn-randomize-placement" class="btn btn-secondary" onclick="app.handleRandomizePlacement()">
                        🎲 Randomize Fleet
                    </button>
                    <button id="btn-reset-placement" class="btn btn-secondary" onclick="app.resetPlacement()">
                        🔄 Reset Fleet
                    </button>
                    <button id="btn-ready-placement" class="btn btn-success" style="margin-left: auto;" onclick="app.submitPlacement()" disabled>
                        ⚓ Lock Fleet & Ready
                    </button>
                </div>
            `;
        }

        document.getElementById('placement-controls-row').style.display = 'flex';
        this.renderDockShips();
        this.renderPlacementBoard(true);
    }

    renderDockShips() {
        const container = document.getElementById('placement-dock-ships');
        if (!container) return;
        container.innerHTML = '';

        FLEET_DEFINITIONS.forEach(def => {
            const isPlaced = this.placedShips.some(s => s.id === def.id);
            const isSelected = (this.selectedShipId === def.id);

            const card = document.createElement('div');
            card.className = `ship-card ${isSelected ? 'selected' : ''} ${isPlaced ? 'placed' : ''}`;
            card.onclick = () => {
                this.selectedShipId = def.id;
                this.renderDockShips();
                window.soundEngine.sonarPing();
            };

            let segs = '';
            for (let i = 0; i < def.size; i++) segs += '<div class="ship-segment"></div>';

            card.innerHTML = `
                <div class="ship-card-name">${def.name} (${def.size})</div>
                <div class="ship-card-segments">${segs}</div>
                <div style="font-size:0.75rem; color:${isPlaced ? 'var(--accent-green)' : 'var(--text-muted)'};">
                    ${isPlaced ? '✓ Deployed' : 'Ready to deploy'}
                </div>
            `;
            container.appendChild(card);
        });

        // Update ready button
        const readyBtn = document.getElementById('btn-ready-placement');
        if (readyBtn) {
            const allPlaced = (this.placedShips.length === FLEET_DEFINITIONS.length);
            readyBtn.disabled = !allPlaced;
            readyBtn.style.opacity = allPlaced ? '1' : '0.5';
        }
    }

    toggleOrientation() {
        this.placementOrientation = (this.placementOrientation === 'H') ? 'V' : 'H';
        const btn = document.getElementById('btn-toggle-orientation');
        if (btn) {
            btn.textContent = `Orientation: ${this.placementOrientation === 'H' ? 'Horizontal ↔' : 'Vertical ↕'} (Press R)`;
        }
        window.soundEngine.sonarPing();
    }

    renderPlacementBoard(interactive) {
        const container = document.getElementById('placement-board-container');
        container.innerHTML = '';

        const table = document.createElement('table');
        table.className = 'grid-table';

        // Column Headers (A-J)
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.appendChild(document.createElement('th'));
        for (let c = 0; c < 10; c++) {
            const th = document.createElement('th');
            th.className = 'coord-cell';
            th.textContent = String.fromCharCode(65 + c);
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Grid Rows
        const tbody = document.createElement('tbody');
        for (let r = 0; r < 10; r++) {
            const tr = document.createElement('tr');
            const th = document.createElement('th');
            th.className = 'coord-cell';
            th.textContent = r + 1;
            tr.appendChild(th);

            for (let c = 0; c < 10; c++) {
                const td = document.createElement('td');
                td.className = 'board-cell';
                td.dataset.r = r;
                td.dataset.c = c;

                const placedShip = this.placedShips.find(s => s.cells.some(cell => cell.r === r && cell.c === c));
                if (placedShip) {
                    td.classList.add('cell-ship');
                    td.title = `${placedShip.name} (Tap to remove)`;
                    if (interactive) {
                        td.onclick = () => this.removePlacedShip(placedShip.id);
                    }
                } else if (interactive) {
                    td.onmouseenter = () => this.handlePlacementHover(r, c, true);
                    td.onmouseleave = () => this.handlePlacementHover(r, c, false);
                    td.onclick = () => this.handlePlacementClick(r, c);
                }

                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        container.appendChild(table);
    }

    getShipCellsForPlacement(r, c, size, orientation) {
        const cells = [];
        for (let i = 0; i < size; i++) {
            const cr = (orientation === 'V') ? r + i : r;
            const cc = (orientation === 'H') ? c + i : c;
            cells.push({ r: cr, c: cc });
        }
        return cells;
    }

    handlePlacementHover(r, c, isEnter) {
        document.querySelectorAll('#placement-board-container .board-cell').forEach(el => {
            el.classList.remove('cell-preview-valid', 'cell-preview-invalid');
        });

        if (!isEnter) return;

        const def = FLEET_DEFINITIONS.find(d => d.id === this.selectedShipId);
        if (!def) return;

        const cells = this.getShipCellsForPlacement(r, c, def.size, this.placementOrientation);
        let isValid = true;

        for (const cell of cells) {
            if (cell.r < 0 || cell.r > 9 || cell.c < 0 || cell.c > 9) {
                isValid = false;
                break;
            }
            const collision = this.placedShips.some(s =>
                s.id !== this.selectedShipId && s.cells.some(c2 => c2.r === cell.r && c2.c === cell.c)
            );
            if (collision) {
                isValid = false;
                break;
            }
        }

        cells.forEach(cell => {
            if (cell.r >= 0 && cell.r <= 9 && cell.c >= 0 && cell.c <= 9) {
                const el = document.querySelector(`#placement-board-container td[data-r="${cell.r}"][data-c="${cell.c}"]`);
                if (el) {
                    el.classList.add(isValid ? 'cell-preview-valid' : 'cell-preview-invalid');
                }
            }
        });
    }

    handlePlacementClick(r, c) {
        const def = FLEET_DEFINITIONS.find(d => d.id === this.selectedShipId);
        if (!def) return;

        const cells = this.getShipCellsForPlacement(r, c, def.size, this.placementOrientation);

        for (const cell of cells) {
            if (cell.r < 0 || cell.r > 9 || cell.c < 0 || cell.c > 9) {
                window.soundEngine.defeatSound();
                return;
            }
            const collision = this.placedShips.some(s =>
                s.id !== this.selectedShipId && s.cells.some(c2 => c2.r === cell.r && c2.c === cell.c)
            );
            if (collision) {
                window.soundEngine.defeatSound();
                return;
            }
        }

        this.placedShips = this.placedShips.filter(s => s.id !== def.id);
        this.placedShips.push({
            id: def.id,
            name: def.name,
            size: def.size,
            cells
        });

        window.soundEngine.sonarPing();

        const nextUnplaced = FLEET_DEFINITIONS.find(d => !this.placedShips.some(s => s.id === d.id));
        if (nextUnplaced) {
            this.selectedShipId = nextUnplaced.id;
        }

        this.renderDockShips();
        this.renderPlacementBoard(true);
    }

    removePlacedShip(shipId) {
        this.placedShips = this.placedShips.filter(s => s.id !== shipId);
        this.selectedShipId = shipId;
        window.soundEngine.sonarPing();
        this.renderDockShips();
        this.renderPlacementBoard(true);
    }

    resetPlacement() {
        this.placedShips = [];
        this.selectedShipId = 'carrier';
        window.soundEngine.sonarPing();
        this.renderDockShips();
        this.renderPlacementBoard(true);
    }

    async handleRandomizePlacement() {
        try {
            const res = await fetch(`/api/games/${this.activeGameId}/randomize`, {
                method: 'POST'
            });
            const data = await res.json();
            if (data.ships) {
                this.placedShips = data.ships;
                window.soundEngine.sonarPing();
                this.renderDockShips();
                this.renderPlacementBoard(true);
            }
        } catch (e) {
            console.error('Error getting random fleet:', e);
        }
    }

    async submitPlacement() {
        if (this.placedShips.length !== FLEET_DEFINITIONS.length) {
            alert('Please place all 5 ships on the grid before locking your fleet.');
            return;
        }

        try {
            const res = await fetch(`/api/games/${this.activeGameId}/ready`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    playerId: this.currentPlayer.id,
                    ships: this.placedShips
                })
            });
            const data = await res.json();
            if (data.success) {
                window.soundEngine.sonarPing();
                await this.fetchGameState();
            } else {
                alert(data.error || 'Failed to submit fleet');
            }
        } catch (e) {
            alert('Error communicating with server');
        }
    }

    // =========================================================================
    // Combat Screen (Dual Grids + Prominent Turn Prompt Banner)
    // =========================================================================

    setMobileActiveBoard(name) {
        this.mobileActiveBoard = name;
        const radarCard = document.getElementById('radar-board-card');
        const fleetCard = document.getElementById('fleet-board-card');
        const tabRadar = document.getElementById('tab-btn-radar');
        const tabFleet = document.getElementById('tab-btn-fleet');

        if (name === 'radar') {
            radarCard.classList.remove('mobile-hidden');
            fleetCard.classList.add('mobile-hidden');
            tabRadar.classList.add('active');
            tabFleet.classList.remove('active');
        } else {
            fleetCard.classList.remove('mobile-hidden');
            radarCard.classList.add('mobile-hidden');
            tabFleet.classList.add('active');
            tabRadar.classList.remove('active');
        }
    }

    renderCombatScreen(prev, cur) {
        if (!cur) return;

        const banner = document.getElementById('turn-banner');
        const icon = document.getElementById('turn-banner-icon');
        const title = document.getElementById('turn-banner-title');
        const sub = document.getElementById('turn-banner-sub');
        const radarCard = document.getElementById('radar-board-card');
        const radarHint = document.getElementById('radar-hint-text');

        banner.classList.remove('my-turn', 'opponent-turn', 'game-over');

        if (cur.phase === 'finished') {
            banner.classList.add('game-over');
            const won = (cur.winnerId === this.currentPlayer.id);
            icon.textContent = won ? '🏆' : '💀';
            title.textContent = won ? 'VICTORY — ENEMY FLEET DESTROYED!' : 'DEFEAT — FLEET ELIMINATED';
            sub.textContent = won ? 'All hostile targets eliminated.' : 'Our ships have been sunk.';
            radarCard.classList.remove('active-target');
            radarCard.classList.add('target-locked');
            radarHint.textContent = 'Battle concluded';
        } else if (cur.isMyTurn) {
            banner.classList.add('my-turn');
            icon.textContent = '🎯';
            title.textContent = 'YOUR TURN TO ATTACK!';
            sub.textContent = 'Tap any open coordinate on the Radar Grid to fire a missile.';

            radarCard.classList.add('active-target');
            radarCard.classList.remove('target-locked');
            radarHint.textContent = 'Tap cell to launch missile';

            // If turn just transitioned to me, alert and auto-switch mobile tab to radar
            if (prev && prev.currentTurnPlayerId !== cur.currentTurnPlayerId) {
                window.soundEngine.sonarPing();
                this.setMobileActiveBoard('radar');
            }
        } else {
            banner.classList.add('opponent-turn');
            icon.textContent = '⏳';
            const oppName = (this.currentPlayer.id === cur.player1Id) ? cur.player2Name : cur.player1Name;
            title.textContent = `OPPONENT'S TURN — BRACE FOR IMPACT!`;
            sub.textContent = `Waiting for ${this.escape(oppName || 'Opponent')} to fire...`;

            radarCard.classList.remove('active-target');
            radarCard.classList.add('target-locked');
            radarHint.textContent = 'Targeting locked — waiting for opponent';
        }

        // Render Grids
        this.renderRadarGrid();
        this.renderFleetGrid();

        // Render Intel & Log
        this.renderFleetIntel();
        this.renderCombatLog();
    }

    renderRadarGrid() {
        const container = document.getElementById('radar-board-container');
        container.innerHTML = '';

        const table = document.createElement('table');
        table.className = `grid-table ${this.gameState.isMyTurn && this.gameState.phase === 'playing' ? 'board-interactive' : ''}`;

        // Header (A-J)
        const thead = document.createElement('thead');
        const hRow = document.createElement('tr');
        hRow.appendChild(document.createElement('th'));
        for (let c = 0; c < 10; c++) {
            const th = document.createElement('th');
            th.className = 'coord-cell';
            th.textContent = String.fromCharCode(65 + c);
            hRow.appendChild(th);
        }
        thead.appendChild(hRow);
        table.appendChild(thead);

        // Body
        const tbody = document.createElement('tbody');
        const radarShots = this.gameState.radarShots || [];
        const oppSunkShips = this.gameState.opponentSunkShips || [];

        for (let r = 0; r < 10; r++) {
            const tr = document.createElement('tr');
            const th = document.createElement('th');
            th.className = 'coord-cell';
            th.textContent = r + 1;
            tr.appendChild(th);

            for (let c = 0; c < 10; c++) {
                const td = document.createElement('td');
                td.className = 'board-cell';
                td.dataset.r = r;
                td.dataset.c = c;

                const shot = radarShots.find(s => s.r === r && s.c === c);
                if (shot) {
                    td.classList.add('cell-shot');
                    if (shot.result === 'hit') {
                        td.classList.add('cell-hit');
                        const isSunk = oppSunkShips.some(s => s.cells.some(cell => cell.r === r && cell.c === c));
                        if (isSunk) td.classList.add('cell-sunk');
                    } else {
                        td.classList.add('cell-miss');
                    }
                } else if (this.gameState.isMyTurn && this.gameState.phase === 'playing') {
                    td.onclick = () => this.handleFireShot(r, c);
                }

                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        container.appendChild(table);
    }

    renderFleetGrid() {
        const container = document.getElementById('fleet-board-container');
        container.innerHTML = '';

        const table = document.createElement('table');
        table.className = 'grid-table';

        // Header (A-J)
        const thead = document.createElement('thead');
        const hRow = document.createElement('tr');
        hRow.appendChild(document.createElement('th'));
        for (let c = 0; c < 10; c++) {
            const th = document.createElement('th');
            th.className = 'coord-cell';
            th.textContent = String.fromCharCode(65 + c);
            hRow.appendChild(th);
        }
        thead.appendChild(hRow);
        table.appendChild(thead);

        // Body
        const tbody = document.createElement('tbody');
        const myShips = this.gameState.myShips || [];
        const incomingShots = this.gameState.incomingShots || [];

        for (let r = 0; r < 10; r++) {
            const tr = document.createElement('tr');
            const th = document.createElement('th');
            th.className = 'coord-cell';
            th.textContent = r + 1;
            tr.appendChild(th);

            for (let c = 0; c < 10; c++) {
                const td = document.createElement('td');
                td.className = 'board-cell';

                const ship = myShips.find(s => s.cells.some(cell => cell.r === r && cell.c === c));
                if (ship) {
                    td.classList.add('cell-ship');
                    if (ship.sunk) td.classList.add('cell-sunk');
                }

                const shot = incomingShots.find(s => s.r === r && s.c === c);
                if (shot) {
                    if (shot.result === 'hit') {
                        td.classList.add('cell-hit');
                    } else {
                        td.classList.add('cell-miss');
                    }
                }

                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        container.appendChild(table);
    }

    renderFleetIntel() {
        const myContainer = document.getElementById('my-fleet-intel');
        myContainer.innerHTML = '';
        (this.gameState.myShips || []).forEach(s => {
            const badge = document.createElement('div');
            badge.className = `intel-badge ${s.sunk ? 'sunk' : ''}`;
            badge.innerHTML = `<span>${s.name} (${s.size - s.hits}/${s.size})</span> ${s.sunk ? '💥 SUNK' : '⚓'}`;
            myContainer.appendChild(badge);
        });

        const enemyContainer = document.getElementById('enemy-fleet-intel');
        enemyContainer.innerHTML = '';
        const oppSunk = this.gameState.opponentSunkShips || [];
        FLEET_DEFINITIONS.forEach(def => {
            const sunk = oppSunk.some(s => s.id === def.id);
            const badge = document.createElement('div');
            badge.className = `intel-badge ${sunk ? 'sunk' : ''}`;
            badge.innerHTML = `<span>${def.name} (${def.size})</span> ${sunk ? '💥 SUNK' : '❓ ACTIVE'}`;
            enemyContainer.appendChild(badge);
        });
    }

    renderCombatLog() {
        const logBox = document.getElementById('combat-log-entries');
        logBox.innerHTML = '';
        (this.gameState.log || []).slice(-20).forEach(entry => {
            const line = document.createElement('div');
            line.className = 'log-entry';
            line.textContent = entry;
            logBox.appendChild(line);
        });
    }

    async handleFireShot(r, c) {
        if (!this.gameState.isMyTurn || this.gameState.phase !== 'playing') return;

        window.soundEngine.launchMissile();

        try {
            const res = await fetch(`/api/games/${this.activeGameId}/fire`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    playerId: this.currentPlayer.id,
                    r, c
                })
            });
            const data = await res.json();
            if (data.result === 'hit') {
                if (data.sunk) {
                    window.soundEngine.shipSunk();
                } else {
                    window.soundEngine.hitExplosion();
                }
            } else if (data.result === 'miss') {
                window.soundEngine.waterSplash();
            }

            await this.fetchGameState();
        } catch (e) {
            console.error('Error firing missile:', e);
        }
    }

    async requestRematch() {
        if (!this.activeGameId) return;
        try {
            const res = await fetch(`/api/games/${this.activeGameId}/rematch`, {
                method: 'POST'
            });
            const data = await res.json();
            if (data.success) {
                window.soundEngine.sonarPing();
                this.placedShips = [];
                await this.fetchGameState();
            }
        } catch (e) {
            alert('Error requesting rematch');
        }
    }

    showGameOverModal(won) {
        const modal = document.getElementById('game-over-modal');
        const icon = document.getElementById('modal-icon');
        const title = document.getElementById('modal-title');
        const desc = document.getElementById('modal-desc');

        if (won) {
            window.soundEngine.victoryFanfare();
            icon.textContent = '🏆';
            title.textContent = 'VICTORY ACHIEVED!';
            title.style.color = 'var(--accent-gold)';
            desc.textContent = 'Congratulations, Commander! You have eliminated all enemy naval targets.';
        } else {
            window.soundEngine.defeatSound();
            icon.textContent = '💀';
            title.textContent = 'FLEET DESTROYED';
            title.style.color = 'var(--accent-red)';
            desc.textContent = 'Our entire naval armada was lost. Regroup and deploy for another operation.';
        }

        modal.classList.add('active');
    }

    closeModal() {
        document.getElementById('game-over-modal').classList.remove('active');
    }

    escape(str) {
        if (!str) return '';
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }
}

window.app = new BattleshipApp();
