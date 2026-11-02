# ⚓ Battleships: Tactical Command Center

A modern, responsive, browser-based implementation of the classic **Milton Bradley Battleships** board game, designed for dedicated hosting on a home server accessible across your local home network (LAN).

---

## 🎯 Features Included in Sprint 1 (POC)

- **Authentic Classic Rules**:
  - $10 \times 10$ Tactical Grids (Columns A–J, Rows 1–10).
  - Standard 5-ship fleet:
    1. **Aircraft Carrier** (5 cells)
    2. **Battleship** (4 cells)
    3. **Cruiser** (3 cells)
    4. **Submarine** (3 cells)
    5. **Destroyer** (2 cells)
  - Strict alternating turns (1 shot per player per turn).
  - Accurate hit/miss calculation with immediate vessel sink announcements (*"Enemy Battleship Sunk!"*).
  - Total fleet health of 17 hit points.
- **Dual Display Model**:
  - **Radar Grid (Offensive)**: Click to fire at unattacked coordinates; displays hits (red explosion pegs), misses (white sonar splash pegs), and revealed sunken enemy ships.
  - **Fleet Grid (Defensive)**: Displays your own ships and tracks all incoming enemy fire.
- **Both Placement Modes**:
  - **Manual Interactive Deployment**: Select ship from dock, toggle orientation (Horizontal / Vertical or press `R`), hover for valid/invalid ghost footprint preview, click to deploy. Click placed ship on grid to remove or reposition.
  - **Random Auto-Placement**: One-click procedural placement adhering strictly to collision and board boundary constraints.
- **Player Registration & Seamless Resume**:
  - Choose existing commander from the dropdown or register a new commander name.
  - Session persists in `localStorage`—if you refresh or close your browser, your commander identity and active match automatically resume.
- **Server Persistence**:
  - Game states, ship coordinates, and shot histories are saved to `data/battleships_state.json`.
  - Server restarts or network interruptions preserve ongoing battles.
- **Fog of War (Server-Side Anti-Cheat)**:
  - Un-sunk opponent ship coordinates are **never transmitted** to the attacking client. Only verified hits and misses are delivered.
- **Real-Time Zero-Latency Synchronization**:
  - Server-Sent Events (SSE) update opponent displays immediately when a shot is fired, with automatic reconnect and interval polling fallback.
- **Web Audio Sound Synthesizer**:
  - Zero external sound files needed—uses procedural Web Audio oscillators for submarine sonar pings, missile launches, explosion rumbles, water splashes, alarm sirens, and victory fanfare (with sound mute toggle).

---

## 🚀 How to Run the Home Server

### Option 1: Double-Click Launcher (Windows)
Double-click [`start-server.bat`](file:///c:/Dev/Battleships/start-server.bat).

### Option 2: From PowerShell or Terminal
```powershell
cd C:\Dev\Battleships
javac -d bin src\BattleshipsServer.java
java -cp bin BattleshipsServer 8765
```

---

## 🌐 Connecting Across Your Home Network

When the server starts, it prints all accessible URLs:

```text
==================================================================
   ⚓  BATTLESHIPS COMMAND CENTER - HOME SERVER ONLINE  ⚓
==================================================================
  Local Access:        http://localhost:8765
  Home Network Access: http://192.168.1.xxx:8765
------------------------------------------------------------------
  Database Storage:    C:\Dev\Battleships\data\battleships_state.json
==================================================================
```

1. **Host Computer**: Open `http://localhost:8765` in Chrome, Edge, or Firefox.
2. **Second Player (Laptop, iPad, iPhone, Android)**: Open `http://<YOUR-HOME-IP>:8765` on any device connected to the same home Wi-Fi network.
3. Player 1 creates an operation (or selects their commander name).
4. Player 2 joins the operation from their device.
5. Both deploy their fleets and battle!

---

## 🗺️ Incremental Agile Roadmap

- [x] **Sprint 1 (POC)**: Core rules, dual grids, manual & random placement, server persistence, home LAN hosting, audio FX.
- [ ] **Sprint 2**: Ship drag-and-drop mechanics, animated radar sweep lines, water explosion particles, shot replay.
- [ ] **Sprint 3**: Commander passwords / PINs, career win/loss statistics and accuracy tracking, rematch score tally.
- [ ] **Sprint 4**: Salvo combat variant (shots equal to remaining fleet count) and solo player vs AI mode.

