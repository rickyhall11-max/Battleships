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

        // Create Game
        document.getElementById('btn-create-game').addEventListener('click', () => this.handleCreateGame());

        // Placement controls
        document.getElementById('btn-toggle-orientation').addEventListener('click', () => this.toggleOrientation());
        document.getElementById('btn-randomize-placement').addEventListener('click', () => this.handleRandomizePlacement());
        document.getElementById('btn-reset-placement').addEventListener('click', () => this.resetPlacement());
        document.getElementById('btn-ready-placement').addEventListener('click', () => this.submitPlacement());

        // Navigation
        document.getElementById('btn-leave-game').addEventListener('click', () => this.leaveActiveGame());
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
        document.getElementById('player-active-section').style.display = 'block';
        document.getElementById('player-auth-section').style.display = 'none';

        this.loadGames();
    }

    clearPlayer() {
        this.currentPlayer = null;
        localStorage.removeItem('battleships_player_id');
        localStorage.removeItem('battleships_player_name');
        localStorage.removeItem('battleships_active_game_id');

        document.getElementById('player-active-section').style.display = 'none';
        document.getElementById('player-auth-section').style.display = 'block';
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
        this.pollInterval = setInterval(() => this.loadGames(), 4000);
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
        const list = document.getElementById('games-list-container');
        if (!games || games.length === 0) {
            list.innerHTML = '<div style="color:var(--text-muted); padding:1rem; text-align:center;">No battles active. Create one to begin!</div>';
            return;
        }

        list.innerHTML = '';
        games.forEach(g => {
            const isMyGame = (g.player1Id === this.currentPlayer.id || g.player2Id === this.currentPlayer.id);
            const canJoin = (!isMyGame && !g.player2Id && g.phase === 'waiting');

            let badgeClass = 'badge-waiting';
            let badgeText = 'Waiting for Opponent';
            if (g.phase === 'placement') {
                badgeClass = 'badge-placement';
                badgeText = 'Fleet Deployment';
            } else if (g.phase === 'playing') {
                badgeClass = 'badge-playing';
                badgeText = (g.currentTurnPlayerId === this.currentPlayer.id) ? 'Your Turn' : 'Active Battle';
            } else if (g.phase === 'finished') {
                badgeClass = 'badge-finished';
                badgeText = (g.winnerId === this.currentPlayer.id) ? 'Victory' : 'Finished';
            }

            const item = document.createElement('div');
            item.className = 'game-item';

            const p1 = g.player1Name || 'Commander 1';
            const p2 = g.player2Name || (g.phase === 'waiting' ? 'Open Seat' : 'Commander 2');

            let actionBtn = '';
            if (isMyGame) {
                actionBtn = `<button class="btn btn-secondary" onclick="app.resumeGame('${g.id}')">Resume Battle</button>`;
            } else if (canJoin) {
                actionBtn = `<button class="btn" onclick="app.joinGame('${g.id}')">Join Battle</button>`;
            } else {
                actionBtn = `<button class="btn btn-secondary" style="opacity:0.6;" onclick="app.resumeGame('${g.id}')">Spectate</button>`;
            }

            item.innerHTML = `
                <div class="game-item-info">
                    <div class="game-item-name">${this.escape(g.name)}</div>
                    <div class="game-item-players">👥 ${this.escape(p1)} vs ${this.escape(p2)}</div>
                    <div><span class="game-badge ${badgeClass}">${badgeText}</span></div>
                </div>
                <div>${actionBtn}</div>
            `;
            list.appendChild(item);
        });
    }

    async handleCreateGame() {
        if (!this.currentPlayer) return;
        const input = document.getElementById('new-game-input');
        const name = input.value.trim();

        try {
            const res = await fetch('/api/games', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    playerId: this.currentPlayer.id,
                    name: name || undefined
                })
            });
            const data = await res.json();
            if (data.id) {
                input.value = '';
                window.soundEngine.sonarPing();
                this.resumeGame(data.id);
            } else {
                alert(data.error || 'Failed to create battle');
            }
        } catch (e) {
            alert('Error creating battle');
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
        localStorage.removeItem('battleships_active_game_id');
        this.stopGameStream();
        this.showScreen('lobby');
    }

    startEventStream(gameId) {
        this.stopGameStream();

        // Connect Server-Sent Events (SSE)
        try {
            this.eventSource = new EventSource(`/api/stream?gameId=${gameId}`);
            this.eventSource.addEventListener('game_update', () => {
                this.fetchGameState();
            });
            this.eventSource.onerror = () => {
                // SSE error fallback to polling
                console.warn('SSE disconnected, falling back to interval refresh');
            };
        } catch (e) {
            console.warn('SSE not supported, using polling fallback');
        }

        // Keep 3s backup polling in case SSE misses an event
        this.pollInterval = setInterval(() => this.fetchGameState(), 3000);
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

        // Waiting for P2
        if (cur.phase === 'waiting') {
            this.showScreen('placement');
            this.renderWaitingForP2Screen();
            return;
        }

        // Placement Phase
        if (cur.phase === 'placement') {
            this.showScreen('placement');
            if (cur.myReady) {
                this.renderWaitingForOpponentPlacement();
            } else {
                this.renderPlacementEditor();
            }
            return;
        }

        // Active Playing or Finished Phase
        if (cur.phase === 'playing' || cur.phase === 'finished') {
            this.showScreen('combat');
            this.renderCombatScreen();

            // Sound cue when turn switches to me
            if (prev && prev.currentTurnPlayerId !== cur.currentTurnPlayerId && cur.isMyTurn && cur.phase === 'playing') {
                window.soundEngine.sonarPing();
            }

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
        dock.innerHTML = `
            <div style="text-align:center; padding:2rem;">
                <div class="status-pulse" style="margin:0 auto 1rem auto; width:20px; height:20px;"></div>
                <h3 style="color:var(--accent-cyan); margin-bottom:0.5rem;">WAITING FOR PLAYER 2</h3>
                <p style="color:var(--text-muted);">Share your home network IP with another player to join this battle!</p>
            </div>
        `;
        document.getElementById('placement-controls-row').style.display = 'none';
        document.getElementById('placement-board-container').innerHTML = '';
    }

    renderWaitingForOpponentPlacement() {
        const dock = document.getElementById('placement-dock-container');
        dock.innerHTML = `
            <div style="text-align:center; padding:1.5rem;">
                <div class="status-pulse" style="margin:0 auto 0.75rem auto;"></div>
                <h3 style="color:var(--accent-green); margin-bottom:0.5rem;">FLEET LOCKED AND ARMED</h3>
                <p style="color:var(--text-muted);">Waiting for enemy commander to complete deployment...</p>
            </div>
        `;
        document.getElementById('placement-controls-row').style.display = 'none';
        this.renderPlacementBoard(false); // view-only
    }

    renderPlacementEditor() {
        document.getElementById('placement-controls-row').style.display = 'flex';
        this.renderDockShips();
        this.renderPlacementBoard(true); // interactive
    }

    renderDockShips() {
        const container = document.getElementById('placement-dock-ships');
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

        // Update ready button state
        const readyBtn = document.getElementById('btn-ready-placement');
        const allPlaced = (this.placedShips.length === FLEET_DEFINITIONS.length);
        readyBtn.disabled = !allPlaced;
        readyBtn.style.opacity = allPlaced ? '1' : '0.5';
    }

    toggleOrientation() {
        this.placementOrientation = (this.placementOrientation === 'H') ? 'V' : 'H';
        document.getElementById('btn-toggle-orientation').textContent = `Orientation: ${this.placementOrientation === 'H' ? 'Horizontal ↔' : 'Vertical ↕'} (Press R)`;
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
        headerRow.appendChild(document.createElement('th')); // Top-left corner
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
            // Row Header (1-10)
            const th = document.createElement('th');
            th.className = 'coord-cell';
            th.textContent = r + 1;
            tr.appendChild(th);

            for (let c = 0; c < 10; c++) {
                const td = document.createElement('td');
                td.className = 'board-cell';
                td.dataset.r = r;
                td.dataset.c = c;

                // Check if cell has a placed ship
                const placedShip = this.placedShips.find(s => s.cells.some(cell => cell.r === r && cell.c === c));
                if (placedShip) {
                    td.classList.add('cell-ship');
                    td.title = `${placedShip.name} (Click to remove)`;
                    if (interactive) {
                        td.onclick = () => this.removePlacedShip(placedShip.id);
                    }
                } else if (interactive) {
                    // Hover events for ghost placement preview
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
        // Clear all previous previews
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
            // Check collision with other placed ships (excluding currently selected ship)
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

        // Validate bounds and collisions
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

        // Remove old placement of this ship if already placed
        this.placedShips = this.placedShips.filter(s => s.id !== def.id);

        // Add new placement
        this.placedShips.push({
            id: def.id,
            name: def.name,
            size: def.size,
            cells
        });

        window.soundEngine.sonarPing();

        // Advance to next unplaced ship automatically
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
    // Combat Screen (Dual Grids)
    // =========================================================================

    renderCombatScreen() {
        const cur = this.gameState;
        if (!cur) return;

        // Tactical Status Callout
        const pulse = document.getElementById('combat-turn-pulse');
        const headline = document.getElementById('combat-turn-headline');
        const sub = document.getElementById('combat-turn-sub');

        if (cur.phase === 'finished') {
            const won = (cur.winnerId === this.currentPlayer.id);
            pulse.style.background = won ? 'var(--accent-gold)' : 'var(--accent-red)';
            headline.textContent = won ? '🏆 VICTORY - ENEMY FLEET DESTROYED!' : '💀 DEFEAT - FLEET LOST';
            sub.textContent = won ? 'All hostile targets eliminated.' : 'Our ships have been sunk.';
        } else if (cur.isMyTurn) {
            pulse.style.background = 'var(--accent-cyan)';
            headline.textContent = '🎯 YOUR TURN TO FIRE!';
            sub.textContent = 'Select target coordinates on the Radar Grid.';
        } else {
            pulse.style.background = 'var(--accent-gold)';
            const oppName = (this.currentPlayer.id === cur.player1Id) ? cur.player2Name : cur.player1Name;
            headline.textContent = `⏳ ${this.escape(oppName || 'OPPONENT')}'S TURN`;
            sub.textContent = 'Brace for incoming hostile fire...';
        }

        // Render Grids
        this.renderRadarGrid();
        this.renderFleetGrid();

        // Render Fleet Intel Status
        this.renderFleetIntel();

        // Render Combat Activity Log
        this.renderCombatLog();
    }

    renderRadarGrid() {
        const container = document.getElementById('radar-board-container');
        container.innerHTML = '';

        const table = document.createElement('table');
        table.className = `grid-table ${this.gameState.isMyTurn && this.gameState.phase === 'playing' ? 'board-interactive' : ''}`;

        // Thead
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
                        // If cell belongs to a sunk ship, mark as sunk
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

        // Thead
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

                // Does a friendly ship occupy this cell?
                const ship = myShips.find(s => s.cells.some(cell => cell.r === r && cell.c === c));
                if (ship) {
                    td.classList.add('cell-ship');
                    if (ship.sunk) td.classList.add('cell-sunk');
                }

                // Was this cell attacked by enemy?
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
        // Friendly Fleet Intel
        const myContainer = document.getElementById('my-fleet-intel');
        myContainer.innerHTML = '';
        (this.gameState.myShips || []).forEach(s => {
            const badge = document.createElement('div');
            badge.className = `intel-badge ${s.sunk ? 'sunk' : ''}`;
            badge.innerHTML = `<span>${s.name} (${s.size - s.hits}/${s.size})</span> ${s.sunk ? '💥 SUNK' : '⚓'}`;
            myContainer.appendChild(badge);
        });

        // Enemy Fleet Intel
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
            desc.textContent = 'Congratulations, Commander! You have successfully eliminated all enemy naval assets.';
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

