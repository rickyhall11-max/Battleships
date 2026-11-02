import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * BattleshipsServer - Zero-dependency, persistent home-server for classic Battleships.
 * Runs on standard Java 21/25 with no external libraries required.
 */
public class BattleshipsServer {
    private static final int DEFAULT_PORT = 8765;
    private static final Path DATA_DIR = Paths.get("data");
    private static final Path STATE_FILE = DATA_DIR.resolve("battleships_state.json");
    private static final Path PUBLIC_DIR = Paths.get("public");

    // In-memory data protected by lock
    private static final Map<String, Player> players = new ConcurrentHashMap<>();
    private static final Map<String, Game> games = new ConcurrentHashMap<>();

    // SSE client listeners: gameId -> List of SSE emitters
    private static final Map<String, List<SseClient>> sseClients = new ConcurrentHashMap<>();

    public static void main(String[] args) throws IOException {
        int port = DEFAULT_PORT;
        String envPort = System.getenv("PORT");
        if (envPort != null && !envPort.isEmpty()) {
            try {
                port = Integer.parseInt(envPort.trim());
            } catch (NumberFormatException ignored) {}
        }
        if (args.length > 0) {
            try {
                port = Integer.parseInt(args[0]);
            } catch (NumberFormatException ignored) {}
        }

        Files.createDirectories(DATA_DIR);
        loadState();

        HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());

        // API Endpoints
        server.createContext("/api/info", new ApiInfoHandler(port));
        server.createContext("/api/players", new PlayersHandler());
        server.createContext("/api/games", new GamesHandler());
        server.createContext("/api/stream", new SseHandler());

        // Static Web Files
        server.createContext("/", new StaticFileHandler());

        server.start();

        printBanner(port);

        // Save state cleanly on JVM shutdown
        Runtime.getRuntime().addShutdownHook(new Thread(BattleshipsServer::saveState));
    }

    private static void printBanner(int port) {
        System.out.println("==================================================================");
        System.out.println("   ⚓  BATTLESHIPS COMMAND CENTER - HOME SERVER ONLINE  ⚓");
        System.out.println("==================================================================");
        System.out.println("  Local Access:        http://localhost:" + port);

        List<String> lanIps = getLanAddresses();
        for (String ip : lanIps) {
            System.out.println("  Home Network Access: http://" + ip + ":" + port);
        }
        System.out.println("------------------------------------------------------------------");
        System.out.println("  Database Storage:    " + STATE_FILE.toAbsolutePath());
        System.out.println("  Web UI Directory:    " + PUBLIC_DIR.toAbsolutePath());
        System.out.println("  Press Ctrl+C to stop the server safely.");
        System.out.println("==================================================================");
    }

    public static List<String> getLanAddresses() {
        List<String> list = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces.hasMoreElements()) {
                NetworkInterface iface = interfaces.nextElement();
                if (iface.isLoopback() || !iface.isUp() || iface.isVirtual()) continue;
                Enumeration<InetAddress> addresses = iface.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress addr = addresses.nextElement();
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        list.add(addr.getHostAddress());
                    }
                }
            }
        } catch (Exception ignored) {}
        return list;
    }

    // =========================================================================
    // Real-Time SSE Notification
    // =========================================================================
    static class SseClient {
        final HttpExchange exchange;
        final OutputStream os;
        final AtomicBoolean closed = new AtomicBoolean(false);

        SseClient(HttpExchange exchange) {
            this.exchange = exchange;
            this.os = exchange.getResponseBody();
        }

        synchronized boolean send(String eventName, String data) {
            if (closed.get()) return false;
            try {
                String payload = "event: " + eventName + "\ndata: " + data.replace("\n", "") + "\n\n";
                os.write(payload.getBytes(StandardCharsets.UTF_8));
                os.flush();
                return true;
            } catch (IOException e) {
                closed.set(true);
                return false;
            }
        }

        void close() {
            if (closed.compareAndSet(false, true)) {
                try {
                    exchange.close();
                } catch (Exception ignored) {}
            }
        }
    }

    static void notifyGameUpdate(String gameId) {
        List<SseClient> clients = sseClients.get(gameId);
        if (clients != null) {
            clients.removeIf(client -> !client.send("game_update", "{\"gameId\":\"" + gameId + "\"}"));
        }
    }

    // =========================================================================
    // Game Logic & Models
    // =========================================================================
    static class Player {
        String id;
        String name;
        long createdAt;

        Player(String name) {
            this.id = UUID.randomUUID().toString().substring(0, 8);
            this.name = name;
            this.createdAt = System.currentTimeMillis();
        }

        Player(String id, String name, long createdAt) {
            this.id = id;
            this.name = name;
            this.createdAt = createdAt;
        }
    }

    static class Cell {
        int r;
        int c;
        Cell(int r, int c) { this.r = r; this.c = c; }
    }

    static class Ship {
        String id;       // carrier, battleship, cruiser, submarine, destroyer
        String name;     // "Aircraft Carrier", "Battleship", etc.
        int size;
        List<Cell> cells = new ArrayList<>();
        int hits = 0;
        boolean sunk = false;

        Ship(String id, String name, int size) {
            this.id = id;
            this.name = name;
            this.size = size;
        }
    }

    static class Shot {
        int r;
        int c;
        String result; // "hit" or "miss"
        String shipId;
        String shipName;
        boolean sunk;
        long timestamp;

        Shot(int r, int c, String result, String shipId, String shipName, boolean sunk) {
            this.r = r;
            this.c = c;
            this.result = result;
            this.shipId = shipId;
            this.shipName = shipName;
            this.sunk = sunk;
            this.timestamp = System.currentTimeMillis();
        }
    }

    static class Board {
        String playerId;
        boolean ready = false;
        List<Ship> ships = new ArrayList<>();
        List<Shot> shotsReceived = new ArrayList<>();

        Board(String playerId) {
            this.playerId = playerId;
        }

        boolean hasShipAt(int r, int c) {
            for (Ship s : ships) {
                for (Cell cell : s.cells) {
                    if (cell.r == r && cell.c == c) return true;
                }
            }
            return false;
        }

        Ship getShipAt(int r, int c) {
            for (Ship s : ships) {
                for (Cell cell : s.cells) {
                    if (cell.r == r && cell.c == c) return s;
                }
            }
            return null;
        }

        boolean allShipsSunk() {
            if (ships.isEmpty()) return false;
            for (Ship s : ships) {
                if (!s.sunk) return false;
            }
            return true;
        }
    }

    static class Game {
        String id;
        String name;
        String player1Id;
        String player2Id; // null until joined
        String phase; // "waiting", "placement", "playing", "finished"
        String currentTurnPlayerId;
        String winnerId;
        Board board1;
        Board board2;
        List<String> log = new ArrayList<>();
        long createdAt;
        long updatedAt;

        Game(String name, String player1Id) {
            this.id = UUID.randomUUID().toString().substring(0, 8);
            this.name = name;
            this.player1Id = player1Id;
            this.phase = "waiting";
            this.board1 = new Board(player1Id);
            this.createdAt = System.currentTimeMillis();
            this.updatedAt = this.createdAt;
            this.log.add("Game created. Waiting for Player 2 to join.");
        }

        synchronized boolean join(String player2Id) {
            if (this.player2Id != null || this.player1Id.equals(player2Id)) return false;
            this.player2Id = player2Id;
            this.board2 = new Board(player2Id);
            this.phase = "placement";
            this.updatedAt = System.currentTimeMillis();
            Player p2 = players.get(player2Id);
            String p2Name = p2 != null ? p2.name : "Player 2";
            this.log.add(p2Name + " joined the battle. Fleet placement underway!");
            return true;
        }

        Board getBoard(String playerId) {
            if (playerId.equals(player1Id)) return board1;
            if (playerId.equals(player2Id)) return board2;
            return null;
        }

        Board getOpponentBoard(String playerId) {
            if (playerId.equals(player1Id)) return board2;
            if (playerId.equals(player2Id)) return board1;
            return null;
        }

        String getOpponentId(String playerId) {
            if (playerId.equals(player1Id)) return player2Id;
            if (playerId.equals(player2Id)) return player1Id;
            return null;
        }
    }

    // Fleet specification helper
    public static List<Ship> createStandardFleet() {
        List<Ship> fleet = new ArrayList<>();
        fleet.add(new Ship("carrier", "Aircraft Carrier", 5));
        fleet.add(new Ship("battleship", "Battleship", 4));
        fleet.add(new Ship("cruiser", "Cruiser", 3));
        fleet.add(new Ship("submarine", "Submarine", 3));
        fleet.add(new Ship("destroyer", "Destroyer", 2));
        return fleet;
    }

    public static List<Ship> generateRandomPlacement() {
        List<Ship> fleet = createStandardFleet();
        boolean[][] grid = new boolean[10][10];
        Random rand = new Random();

        for (Ship ship : fleet) {
            boolean placed = false;
            int attempts = 0;
            while (!placed && attempts < 200) {
                attempts++;
                boolean horizontal = rand.nextBoolean();
                int r = rand.nextInt(horizontal ? 10 : (10 - ship.size + 1));
                int c = rand.nextInt(horizontal ? (10 - ship.size + 1) : 10);

                boolean canPlace = true;
                for (int i = 0; i < ship.size; i++) {
                    int cr = horizontal ? r : r + i;
                    int cc = horizontal ? c + i : c;
                    if (grid[cr][cc]) {
                        canPlace = false;
                        break;
                    }
                }

                if (canPlace) {
                    ship.cells.clear();
                    for (int i = 0; i < ship.size; i++) {
                        int cr = horizontal ? r : r + i;
                        int cc = horizontal ? c + i : c;
                        grid[cr][cc] = true;
                        ship.cells.add(new Cell(cr, cc));
                    }
                    placed = true;
                }
            }
        }
        return fleet;
    }

    // =========================================================================
    // HTTP Handlers
    // =========================================================================

    static class ApiInfoHandler implements HttpHandler {
        private final int port;
        ApiInfoHandler(int port) { this.port = port; }

        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendError(exchange, 405, "Method not allowed");
                return;
            }
            StringBuilder sb = new StringBuilder("{");
            sb.append("\"port\":").append(port).append(",");
            sb.append("\"lanIps\":[");
            List<String> ips = getLanAddresses();
            for (int i = 0; i < ips.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append("\"").append(ips.get(i)).append("\"");
            }
            sb.append("],\"activeGames\":").append(games.size());
            sb.append(",\"totalPlayers\":").append(players.size());
            sb.append("}");
            sendJson(exchange, 200, sb.toString());
        }
    }

    static class PlayersHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            String method = exchange.getRequestMethod().toUpperCase();
            if ("GET".equals(method)) {
                // List all players
                StringBuilder sb = new StringBuilder("[");
                int count = 0;
                for (Player p : players.values()) {
                    if (count++ > 0) sb.append(",");
                    sb.append("{\"id\":\"").append(escape(p.id))
                      .append("\",\"name\":\"").append(escape(p.name))
                      .append("\",\"createdAt\":").append(p.createdAt).append("}");
                }
                sb.append("]");
                sendJson(exchange, 200, sb.toString());
            } else if ("POST".equals(method)) {
                // Register or find existing player by name
                String body = readBody(exchange);
                String name = parseStringField(body, "name");
                if (name == null || name.trim().isEmpty()) {
                    sendError(exchange, 400, "Player name is required");
                    return;
                }
                name = name.trim();

                // Look up case-insensitively
                Player existing = null;
                for (Player p : players.values()) {
                    if (p.name.equalsIgnoreCase(name)) {
                        existing = p;
                        break;
                    }
                }
                if (existing == null) {
                    existing = new Player(name);
                    players.put(existing.id, existing);
                    saveState();
                }

                String json = "{\"id\":\"" + escape(existing.id) + "\",\"name\":\"" + escape(existing.name) + "\"}";
                sendJson(exchange, 200, json);
            } else {
                sendError(exchange, 405, "Method not allowed");
            }
        }
    }

    static class GamesHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            String method = exchange.getRequestMethod().toUpperCase();
            String path = exchange.getRequestURI().getPath();
            String[] parts = path.split("/");

            // /api/games
            if (parts.length == 3) {
                if ("GET".equals(method)) {
                    // List games
                    StringBuilder sb = new StringBuilder("[");
                    int count = 0;
                    for (Game g : games.values()) {
                        if (count++ > 0) sb.append(",");
                        Player p1 = players.get(g.player1Id);
                        Player p2 = g.player2Id != null ? players.get(g.player2Id) : null;
                        sb.append("{\"id\":\"").append(escape(g.id))
                          .append("\",\"name\":\"").append(escape(g.name))
                          .append("\",\"player1Id\":\"").append(escape(g.player1Id))
                          .append("\",\"player1Name\":\"").append(escape(p1 != null ? p1.name : "Player 1"))
                          .append("\",\"player2Id\":").append(g.player2Id != null ? "\"" + escape(g.player2Id) + "\"" : "null")
                          .append(",\"player2Name\":").append(p2 != null ? "\"" + escape(p2.name) + "\"" : "null")
                          .append(",\"phase\":\"").append(escape(g.phase))
                          .append("\",\"currentTurnPlayerId\":").append(g.currentTurnPlayerId != null ? "\"" + escape(g.currentTurnPlayerId) + "\"" : "null")
                          .append(",\"winnerId\":").append(g.winnerId != null ? "\"" + escape(g.winnerId) + "\"" : "null")
                          .append(",\"updatedAt\":").append(g.updatedAt)
                          .append("}");
                    }
                    sb.append("]");
                    sendJson(exchange, 200, sb.toString());
                    return;
                } else if ("POST".equals(method)) {
                    // Create new game
                    String body = readBody(exchange);
                    String name = parseStringField(body, "name");
                    String playerId = parseStringField(body, "playerId");
                    if (playerId == null || !players.containsKey(playerId)) {
                        sendError(exchange, 400, "Valid playerId is required");
                        return;
                    }
                    if (name == null || name.trim().isEmpty()) {
                        Player p = players.get(playerId);
                        name = (p != null ? p.name : "Captain") + "'s Battle";
                    }

                    Game game = new Game(name.trim(), playerId);
                    games.put(game.id, game);
                    saveState();

                    sendJson(exchange, 201, "{\"id\":\"" + game.id + "\"}");
                    return;
                }
            }

            // Sub-paths: /api/games/{id} or /api/games/{id}/{action}
            if (parts.length >= 4) {
                String gameId = parts[3];
                Game game = games.get(gameId);
                if (game == null) {
                    sendError(exchange, 404, "Game not found");
                    return;
                }

                if (parts.length == 4) {
                    // GET /api/games/{id}?playerId=...
                    if ("GET".equals(method)) {
                        Map<String, String> query = parseQuery(exchange.getRequestURI().getQuery());
                        String playerId = query.get("playerId");
                        if (playerId == null || (!playerId.equals(game.player1Id) && !playerId.equals(game.player2Id))) {
                            // Observer or spectator view (minimal public view)
                            sendJson(exchange, 200, serializeGameForObserver(game));
                        } else {
                            // Player view with strictly protected Fog-of-War
                            sendJson(exchange, 200, serializeGameForPlayer(game, playerId));
                        }
                        return;
                    }
                } else if (parts.length == 5) {
                    String action = parts[4];

                    // POST /api/games/{id}/join
                    if ("join".equals(action) && "POST".equals(method)) {
                        String body = readBody(exchange);
                        String playerId = parseStringField(body, "playerId");
                        if (playerId == null || !players.containsKey(playerId)) {
                            sendError(exchange, 400, "Valid playerId is required");
                            return;
                        }
                        synchronized (game) {
                            if (!game.join(playerId)) {
                                sendError(exchange, 400, "Cannot join this game (already full or same player)");
                                return;
                            }
                        }
                        saveState();
                        notifyGameUpdate(game.id);
                        sendJson(exchange, 200, "{\"success\":true}");
                        return;
                    }

                    // POST /api/games/{id}/randomize
                    if ("randomize".equals(action) && "POST".equals(method)) {
                        List<Ship> randomShips = generateRandomPlacement();
                        StringBuilder sb = new StringBuilder("{\"ships\":[");
                        for (int i = 0; i < randomShips.size(); i++) {
                            if (i > 0) sb.append(",");
                            Ship s = randomShips.get(i);
                            sb.append("{\"id\":\"").append(s.id)
                              .append("\",\"name\":\"").append(s.name)
                              .append("\",\"size\":").append(s.size)
                              .append(",\"cells\":[");
                            for (int j = 0; j < s.cells.size(); j++) {
                                if (j > 0) sb.append(",");
                                sb.append("{\"r\":").append(s.cells.get(j).r).append(",\"c\":").append(s.cells.get(j).c).append("}");
                            }
                            sb.append("]}");
                        }
                        sb.append("]}");
                        sendJson(exchange, 200, sb.toString());
                        return;
                    }

                    // POST /api/games/{id}/ready
                    if ("ready".equals(action) && "POST".equals(method)) {
                        String body = readBody(exchange);
                        String playerId = parseStringField(body, "playerId");
                        if (playerId == null) {
                            sendError(exchange, 400, "playerId required");
                            return;
                        }
                        Board board = game.getBoard(playerId);
                        if (board == null) {
                            sendError(exchange, 403, "Not a player in this game");
                            return;
                        }

                        // Parse ships list from body
                        List<Ship> submittedFleet = parseShipsFromJson(body);
                        String error = validateFleet(submittedFleet);
                        if (error != null) {
                            sendError(exchange, 400, "Invalid fleet placement: " + error);
                            return;
                        }

                        synchronized (game) {
                            board.ships = submittedFleet;
                            board.ready = true;
                            Player p = players.get(playerId);
                            game.log.add((p != null ? p.name : "A player") + " has locked in their fleet!");

                            // Check if both players are ready
                            Board otherBoard = game.getOpponentBoard(playerId);
                            if (otherBoard != null && otherBoard.ready) {
                                game.phase = "playing";
                                // Randomly or sequentially choose first player
                                game.currentTurnPlayerId = new Random().nextBoolean() ? game.player1Id : game.player2Id;
                                Player firstPlayer = players.get(game.currentTurnPlayerId);
                                game.log.add("Both fleets ready! Battle commences! First strike goes to " + (firstPlayer != null ? firstPlayer.name : "Player") + ".");
                            }
                            game.updatedAt = System.currentTimeMillis();
                        }

                        saveState();
                        notifyGameUpdate(game.id);
                        sendJson(exchange, 200, "{\"success\":true}");
                        return;
                    }

                    // POST /api/games/{id}/fire
                    if ("fire".equals(action) && "POST".equals(method)) {
                        String body = readBody(exchange);
                        String playerId = parseStringField(body, "playerId");
                        Integer r = parseIntField(body, "r");
                        Integer c = parseIntField(body, "c");

                        if (playerId == null || r == null || c == null) {
                            sendError(exchange, 400, "playerId, r, and c are required");
                            return;
                        }

                        if (r < 0 || r > 9 || c < 0 || c > 9) {
                            sendError(exchange, 400, "Coordinates out of bounds (0-9)");
                            return;
                        }

                        Shot resultShot = null;
                        synchronized (game) {
                            if (!"playing".equals(game.phase)) {
                                sendError(exchange, 400, "Game is not in playing phase");
                                return;
                            }
                            if (!playerId.equals(game.currentTurnPlayerId)) {
                                sendError(exchange, 400, "Not your turn");
                                return;
                            }

                            Board oppBoard = game.getOpponentBoard(playerId);
                            if (oppBoard == null) {
                                sendError(exchange, 400, "Opponent not found");
                                return;
                            }

                            // Check if cell already fired upon
                            for (Shot s : oppBoard.shotsReceived) {
                                if (s.r == r && s.c == c) {
                                    sendError(exchange, 400, "Cell already attacked");
                                    return;
                                }
                            }

                            // Calculate Hit / Miss
                            Ship hitShip = oppBoard.getShipAt(r, c);
                            Player attacker = players.get(playerId);
                            Player defender = players.get(game.getOpponentId(playerId));
                            String attName = attacker != null ? attacker.name : "Attacker";
                            String coordStr = "" + ((char)('A' + c)) + (r + 1);

                            if (hitShip != null) {
                                hitShip.hits++;
                                boolean sunk = (hitShip.hits >= hitShip.size);
                                if (sunk) hitShip.sunk = true;

                                resultShot = new Shot(r, c, "hit", hitShip.id, hitShip.name, sunk);
                                oppBoard.shotsReceived.add(resultShot);

                                if (sunk) {
                                    game.log.add("💥 " + attName + " fired at " + coordStr + ": DIRECT HIT! " + hitShip.name + " SUNK!");
                                } else {
                                    game.log.add("🔥 " + attName + " fired at " + coordStr + ": DIRECT HIT!");
                                }

                                // Check victory condition
                                if (oppBoard.allShipsSunk()) {
                                    game.phase = "finished";
                                    game.winnerId = playerId;
                                    game.log.add("🏆 VICTORY! " + attName + " has completely sunk the enemy fleet!");
                                }
                            } else {
                                resultShot = new Shot(r, c, "miss", null, null, false);
                                oppBoard.shotsReceived.add(resultShot);
                                game.log.add("🌊 " + attName + " fired at " + coordStr + ": MISS (Splash!)");
                            }

                            // Strict alternating turns: always switch turn
                            if (!"finished".equals(game.phase)) {
                                game.currentTurnPlayerId = game.getOpponentId(playerId);
                            }
                            game.updatedAt = System.currentTimeMillis();
                        }

                        saveState();
                        notifyGameUpdate(game.id);

                        // Return the outcome of the shot
                        StringBuilder res = new StringBuilder("{");
                        res.append("\"result\":\"").append(resultShot.result).append("\"");
                        if (resultShot.shipName != null) {
                            res.append(",\"shipName\":\"").append(escape(resultShot.shipName)).append("\"");
                        }
                        res.append(",\"sunk\":").append(resultShot.sunk);
                        res.append(",\"gameOver\":").append("finished".equals(game.phase));
                        res.append("}");
                        sendJson(exchange, 200, res.toString());
                        return;
                    }

                    // POST /api/games/{id}/rematch
                    if ("rematch".equals(action) && "POST".equals(method)) {
                        synchronized (game) {
                            game.phase = "placement";
                            game.winnerId = null;
                            game.currentTurnPlayerId = null;
                            game.board1 = new Board(game.player1Id);
                            if (game.player2Id != null) {
                                game.board2 = new Board(game.player2Id);
                            }
                            game.log.add("Rematch requested! Both commanders repositioning fleets.");
                            game.updatedAt = System.currentTimeMillis();
                        }
                        saveState();
                        notifyGameUpdate(game.id);
                        sendJson(exchange, 200, "{\"success\":true}");
                        return;
                    }
                }
            }

            sendError(exchange, 404, "Endpoint not found");
        }
    }

    static class SseHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendError(exchange, 405, "Method not allowed");
                return;
            }

            Map<String, String> query = parseQuery(exchange.getRequestURI().getQuery());
            String gameId = query.get("gameId");
            if (gameId == null || !games.containsKey(gameId)) {
                sendError(exchange, 404, "Game not found");
                return;
            }

            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.getResponseHeaders().set("Cache-Control", "no-cache");
            exchange.getResponseHeaders().set("Connection", "keep-alive");
            exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
            exchange.sendResponseHeaders(200, 0);

            SseClient client = new SseClient(exchange);
            sseClients.computeIfAbsent(gameId, k -> new CopyOnWriteArrayList<>()).add(client);
            client.send("connected", "{\"status\":\"ok\"}");
        }
    }

    // =========================================================================
    // Fog of War / Serialization
    // =========================================================================

    public static String serializeGameForPlayer(Game g, String playerId) {
        StringBuilder sb = new StringBuilder("{");
        sb.append("\"id\":\"").append(escape(g.id)).append("\",");
        sb.append("\"name\":\"").append(escape(g.name)).append("\",");
        sb.append("\"phase\":\"").append(escape(g.phase)).append("\",");
        sb.append("\"player1Id\":\"").append(escape(g.player1Id)).append("\",");
        sb.append("\"player2Id\":").append(g.player2Id != null ? "\"" + escape(g.player2Id) + "\"" : "null").append(",");

        Player p1 = players.get(g.player1Id);
        Player p2 = g.player2Id != null ? players.get(g.player2Id) : null;
        sb.append("\"player1Name\":\"").append(escape(p1 != null ? p1.name : "Player 1")).append("\",");
        sb.append("\"player2Name\":").append(p2 != null ? "\"" + escape(p2.name) + "\"" : "null").append(",");

        sb.append("\"currentTurnPlayerId\":").append(g.currentTurnPlayerId != null ? "\"" + escape(g.currentTurnPlayerId) + "\"" : "null").append(",");
        sb.append("\"winnerId\":").append(g.winnerId != null ? "\"" + escape(g.winnerId) + "\"" : "null").append(",");
        sb.append("\"isMyTurn\":").append(playerId.equals(g.currentTurnPlayerId)).append(",");

        Board myBoard = g.getBoard(playerId);
        Board oppBoard = g.getOpponentBoard(playerId);

        sb.append("\"myReady\":").append(myBoard != null && myBoard.ready).append(",");
        sb.append("\"opponentReady\":").append(oppBoard != null && oppBoard.ready).append(",");

        // My Ships (Visible to me with full positions and hit counts)
        sb.append("\"myShips\":[");
        if (myBoard != null) {
            for (int i = 0; i < myBoard.ships.size(); i++) {
                if (i > 0) sb.append(",");
                Ship s = myBoard.ships.get(i);
                sb.append("{\"id\":\"").append(s.id)
                  .append("\",\"name\":\"").append(s.name)
                  .append("\",\"size\":").append(s.size)
                  .append(",\"hits\":").append(s.hits)
                  .append(",\"sunk\":").append(s.sunk)
                  .append(",\"cells\":[");
                for (int j = 0; j < s.cells.size(); j++) {
                    if (j > 0) sb.append(",");
                    sb.append("{\"r\":").append(s.cells.get(j).r).append(",\"c\":").append(s.cells.get(j).c).append("}");
                }
                sb.append("]}");
            }
        }
        sb.append("],");

        // Incoming Shots (Fired by enemy against my board)
        sb.append("\"incomingShots\":[");
        if (myBoard != null) {
            for (int i = 0; i < myBoard.shotsReceived.size(); i++) {
                if (i > 0) sb.append(",");
                Shot sh = myBoard.shotsReceived.get(i);
                sb.append("{\"r\":").append(sh.r).append(",\"c\":").append(sh.c)
                  .append(",\"result\":\"").append(sh.result).append("\"")
                  .append(",\"sunk\":").append(sh.sunk).append("}");
            }
        }
        sb.append("],");

        // Radar Shots (Fired by me at enemy board: coordinates & results)
        sb.append("\"radarShots\":[");
        if (oppBoard != null) {
            for (int i = 0; i < oppBoard.shotsReceived.size(); i++) {
                if (i > 0) sb.append(",");
                Shot sh = oppBoard.shotsReceived.get(i);
                sb.append("{\"r\":").append(sh.r).append(",\"c\":").append(sh.c)
                  .append(",\"result\":\"").append(sh.result).append("\"")
                  .append(",\"sunk\":").append(sh.sunk);
                if (sh.shipName != null) {
                    sb.append(",\"shipName\":\"").append(escape(sh.shipName)).append("\"");
                }
                sb.append("}");
            }
        }
        sb.append("],");

        // Opponent Sunk Ships (Fog-of-war strictly reveals ONLY ships that are 100% sunk!)
        sb.append("\"opponentSunkShips\":[");
        if (oppBoard != null) {
            int sunkCount = 0;
            for (Ship s : oppBoard.ships) {
                if (s.sunk) {
                    if (sunkCount++ > 0) sb.append(",");
                    sb.append("{\"id\":\"").append(s.id)
                      .append("\",\"name\":\"").append(s.name)
                      .append("\",\"size\":").append(s.size)
                      .append(",\"cells\":[");
                    for (int j = 0; j < s.cells.size(); j++) {
                        if (j > 0) sb.append(",");
                        sb.append("{\"r\":").append(s.cells.get(j).r).append(",\"c\":").append(s.cells.get(j).c).append("}");
                    }
                    sb.append("]}");
                }
            }
        }
        sb.append("],");

        // Activity Log
        sb.append("\"log\":[");
        for (int i = 0; i < g.log.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append("\"").append(escape(g.log.get(i))).append("\"");
        }
        sb.append("]}");
        return sb.toString();
    }

    public static String serializeGameForObserver(Game g) {
        StringBuilder sb = new StringBuilder("{");
        sb.append("\"id\":\"").append(escape(g.id)).append("\",");
        sb.append("\"name\":\"").append(escape(g.name)).append("\",");
        sb.append("\"phase\":\"").append(escape(g.phase)).append("\",");
        sb.append("\"player1Id\":\"").append(escape(g.player1Id)).append("\",");
        sb.append("\"player2Id\":").append(g.player2Id != null ? "\"" + escape(g.player2Id) + "\"" : "null").append(",");
        sb.append("\"currentTurnPlayerId\":").append(g.currentTurnPlayerId != null ? "\"" + escape(g.currentTurnPlayerId) + "\"" : "null").append(",");
        sb.append("\"winnerId\":").append(g.winnerId != null ? "\"" + escape(g.winnerId) + "\"" : "null").append(",");
        sb.append("\"log\":[");
        for (int i = 0; i < g.log.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append("\"").append(escape(g.log.get(i))).append("\"");
        }
        sb.append("]}");
        return sb.toString();
    }

    // =========================================================================
    // Static File Serving
    // =========================================================================

    static class StaticFileHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendError(exchange, 405, "Method not allowed");
                return;
            }

            String path = exchange.getRequestURI().getPath();
            if (path == null || path.equals("/") || path.isEmpty()) {
                path = "/index.html";
            }

            // Clean path against directory traversal
            path = path.replace("\\", "/");
            if (path.contains("..")) {
                sendError(exchange, 403, "Forbidden");
                return;
            }

            Path file = PUBLIC_DIR.resolve(path.substring(1)).normalize();
            if (!file.startsWith(PUBLIC_DIR) || !Files.exists(file) || Files.isDirectory(file)) {
                sendError(exchange, 404, "File not found: " + path);
                return;
            }

            String contentType = getMimeType(file.getFileName().toString());
            byte[] bytes = Files.readAllBytes(file);

            exchange.getResponseHeaders().set("Content-Type", contentType);
            exchange.getResponseHeaders().set("Cache-Control", "no-cache");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        }

        private String getMimeType(String filename) {
            String lower = filename.toLowerCase();
            if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
            if (lower.endsWith(".css")) return "text/css; charset=utf-8";
            if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript; charset=utf-8";
            if (lower.endsWith(".json")) return "application/json; charset=utf-8";
            if (lower.endsWith(".svg")) return "image/svg+xml";
            if (lower.endsWith(".png")) return "image/png";
            if (lower.endsWith(".ico")) return "image/x-icon";
            if (lower.endsWith(".wav")) return "audio/wav";
            if (lower.endsWith(".mp3")) return "audio/mpeg";
            return "application/octet-stream";
        }
    }

    // =========================================================================
    // Fleet Validation Helper
    // =========================================================================

    public static String validateFleet(List<Ship> fleet) {
        if (fleet == null || fleet.size() != 5) {
            return "Must place exactly 5 ships";
        }

        Map<String, Integer> required = new HashMap<>();
        required.put("carrier", 5);
        required.put("battleship", 4);
        required.put("cruiser", 3);
        required.put("submarine", 3);
        required.put("destroyer", 2);

        boolean[][] occupied = new boolean[10][10];

        for (Ship s : fleet) {
            if (!required.containsKey(s.id)) return "Unknown ship id: " + s.id;
            int expectedSize = required.get(s.id);
            if (s.cells.size() != expectedSize) {
                return s.name + " must have " + expectedSize + " cells (got " + s.cells.size() + ")";
            }

            // Verify straight line (horizontal or vertical)
            boolean sameRow = true;
            boolean sameCol = true;
            int firstR = s.cells.get(0).r;
            int firstC = s.cells.get(0).c;

            for (Cell c : s.cells) {
                if (c.r < 0 || c.r > 9 || c.c < 0 || c.c > 9) return s.name + " is out of bounds";
                if (c.r != firstR) sameRow = false;
                if (c.c != firstC) sameCol = false;

                if (occupied[c.r][c.c]) return "Ship collision detected at " + ((char)('A' + c.c)) + (c.r + 1);
                occupied[c.r][c.c] = true;
            }

            if (!sameRow && !sameCol) return s.name + " must be strictly horizontal or vertical";

            // Verify contiguous
            if (sameRow) {
                List<Integer> cols = new ArrayList<>();
                for (Cell c : s.cells) cols.add(c.c);
                Collections.sort(cols);
                for (int i = 1; i < cols.size(); i++) {
                    if (cols.get(i) != cols.get(i - 1) + 1) return s.name + " cells must be contiguous";
                }
            } else {
                List<Integer> rows = new ArrayList<>();
                for (Cell c : s.cells) rows.add(c.r);
                Collections.sort(rows);
                for (int i = 1; i < rows.size(); i++) {
                    if (rows.get(i) != rows.get(i - 1) + 1) return s.name + " cells must be contiguous";
                }
            }
        }
        return null;
    }

    // =========================================================================
    // Persistence (State Save & Load)
    // =========================================================================

    public static synchronized void saveState() {
        try {
            StringBuilder sb = new StringBuilder();
            sb.append("{\n  \"players\": [\n");
            int pCount = 0;
            for (Player p : players.values()) {
                if (pCount++ > 0) sb.append(",\n");
                sb.append("    {\"id\":\"").append(escape(p.id))
                  .append("\",\"name\":\"").append(escape(p.name))
                  .append("\",\"createdAt\":").append(p.createdAt).append("}");
            }
            sb.append("\n  ],\n  \"games\": [\n");
            int gCount = 0;
            for (Game g : games.values()) {
                if (gCount++ > 0) sb.append(",\n");
                sb.append("    {\n");
                sb.append("      \"id\":\"").append(escape(g.id)).append("\",\n");
                sb.append("      \"name\":\"").append(escape(g.name)).append("\",\n");
                sb.append("      \"player1Id\":\"").append(escape(g.player1Id)).append("\",\n");
                sb.append("      \"player2Id\":").append(g.player2Id != null ? "\"" + escape(g.player2Id) + "\"" : "null").append(",\n");
                sb.append("      \"phase\":\"").append(escape(g.phase)).append("\",\n");
                sb.append("      \"currentTurnPlayerId\":").append(g.currentTurnPlayerId != null ? "\"" + escape(g.currentTurnPlayerId) + "\"" : "null").append(",\n");
                sb.append("      \"winnerId\":").append(g.winnerId != null ? "\"" + escape(g.winnerId) + "\"" : "null").append(",\n");
                sb.append("      \"createdAt\":").append(g.createdAt).append(",\n");
                sb.append("      \"updatedAt\":").append(g.updatedAt).append(",\n");
                sb.append("      \"board1\":").append(serializeBoard(g.board1)).append(",\n");
                sb.append("      \"board2\":").append(g.board2 != null ? serializeBoard(g.board2) : "null").append(",\n");
                sb.append("      \"log\":[");
                for (int i = 0; i < g.log.size(); i++) {
                    if (i > 0) sb.append(",");
                    sb.append("\"").append(escape(g.log.get(i))).append("\"");
                }
                sb.append("]\n    }");
            }
            sb.append("\n  ]\n}");

            Path tempFile = DATA_DIR.resolve("state.tmp");
            Files.writeString(tempFile, sb.toString(), StandardCharsets.UTF_8);
            Files.move(tempFile, STATE_FILE, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (Exception e) {
            System.err.println("Failed to save state: " + e.getMessage());
        }
    }

    private static String serializeBoard(Board b) {
        if (b == null) return "null";
        StringBuilder sb = new StringBuilder("{");
        sb.append("\"playerId\":\"").append(escape(b.playerId)).append("\",");
        sb.append("\"ready\":").append(b.ready).append(",");
        sb.append("\"ships\":[");
        for (int i = 0; i < b.ships.size(); i++) {
            if (i > 0) sb.append(",");
            Ship s = b.ships.get(i);
            sb.append("{\"id\":\"").append(s.id)
              .append("\",\"name\":\"").append(s.name)
              .append("\",\"size\":").append(s.size)
              .append(",\"hits\":").append(s.hits)
              .append(",\"sunk\":").append(s.sunk)
              .append(",\"cells\":[");
            for (int j = 0; j < s.cells.size(); j++) {
                if (j > 0) sb.append(",");
                sb.append("{\"r\":").append(s.cells.get(j).r).append(",\"c\":").append(s.cells.get(j).c).append("}");
            }
            sb.append("]}");
        }
        sb.append("],\"shotsReceived\":[");
        for (int i = 0; i < b.shotsReceived.size(); i++) {
            if (i > 0) sb.append(",");
            Shot sh = b.shotsReceived.get(i);
            sb.append("{\"r\":").append(sh.r).append(",\"c\":").append(sh.c)
              .append(",\"result\":\"").append(sh.result).append("\"")
              .append(",\"sunk\":").append(sh.sunk)
              .append(",\"shipId\":").append(sh.shipId != null ? "\"" + escape(sh.shipId) + "\"" : "null")
              .append(",\"shipName\":").append(sh.shipName != null ? "\"" + escape(sh.shipName) + "\"" : "null")
              .append(",\"timestamp\":").append(sh.timestamp).append("}");
        }
        sb.append("]}");
        return sb.toString();
    }

    public static synchronized void loadState() {
        if (!Files.exists(STATE_FILE)) return;
        try {
            String content = Files.readString(STATE_FILE, StandardCharsets.UTF_8);
            parseAndRestoreState(content);
            System.out.println("Restored " + players.size() + " players and " + games.size() + " saved games from disk.");
        } catch (Exception e) {
            System.err.println("Warning: Could not parse saved state: " + e.getMessage());
        }
    }

    // =========================================================================
    // Utilities: JSON Parsing & HTTP Helpers
    // =========================================================================

    private static void sendJson(HttpExchange exchange, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static void sendError(HttpExchange exchange, int status, String msg) throws IOException {
        String json = "{\"error\":\"" + escape(msg) + "\"}";
        sendJson(exchange, status, json);
    }

    private static String readBody(HttpExchange exchange) throws IOException {
        try (InputStream is = exchange.getRequestBody()) {
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static Map<String, String> parseQuery(String query) {
        Map<String, String> map = new HashMap<>();
        if (query == null || query.isEmpty()) return map;
        for (String pair : query.split("&")) {
            String[] kv = pair.split("=", 2);
            if (kv.length == 2) {
                map.put(URLDecoder.decode(kv[0], StandardCharsets.UTF_8), URLDecoder.decode(kv[1], StandardCharsets.UTF_8));
            } else if (kv.length == 1) {
                map.put(URLDecoder.decode(kv[0], StandardCharsets.UTF_8), "");
            }
        }
        return map;
    }

    private static String escape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\b", "\\b")
                .replace("\f", "\\f")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }

    private static String parseStringField(String json, String field) {
        int idx = json.indexOf("\"" + field + "\"");
        if (idx == -1) return null;
        int colon = json.indexOf(':', idx);
        if (colon == -1) return null;
        int firstQuote = json.indexOf('\"', colon);
        if (firstQuote == -1) return null;
        int endQuote = json.indexOf('\"', firstQuote + 1);
        if (endQuote == -1) return null;
        return json.substring(firstQuote + 1, endQuote);
    }

    private static Integer parseIntField(String json, String field) {
        int idx = json.indexOf("\"" + field + "\"");
        if (idx == -1) return null;
        int colon = json.indexOf(':', idx);
        if (colon == -1) return null;
        int start = colon + 1;
        while (start < json.length() && Character.isWhitespace(json.charAt(start))) start++;
        int end = start;
        while (end < json.length() && (Character.isDigit(json.charAt(end)) || json.charAt(end) == '-')) end++;
        if (start == end) return null;
        try {
            return Integer.parseInt(json.substring(start, end));
        } catch (Exception e) {
            return null;
        }
    }

    public static List<Ship> parseShipsFromJson(String json) {
        List<Ship> fleet = new ArrayList<>();
        int shipsIdx = json.indexOf("\"ships\"");
        if (shipsIdx == -1) return fleet;
        int openBracket = json.indexOf('[', shipsIdx);
        if (openBracket == -1) return fleet;

        // Parse individual ship objects inside array
        int cursor = openBracket + 1;
        while (cursor < json.length()) {
            int objStart = json.indexOf('{', cursor);
            if (objStart == -1) break;
            int objEnd = findMatchingBrace(json, objStart);
            if (objEnd == -1) break;

            String shipChunk = json.substring(objStart, objEnd + 1);
            String id = parseStringField(shipChunk, "id");
            String name = parseStringField(shipChunk, "name");
            Integer size = parseIntField(shipChunk, "size");
            if (id != null && size != null) {
                Ship ship = new Ship(id, name != null ? name : id, size);
                // Parse cells inside shipChunk
                int cellsIdx = shipChunk.indexOf("\"cells\"");
                if (cellsIdx != -1) {
                    int cOpen = shipChunk.indexOf('[', cellsIdx);
                    if (cOpen != -1) {
                        int cClose = shipChunk.indexOf(']', cOpen);
                        if (cClose != -1) {
                            String cellsChunk = shipChunk.substring(cOpen + 1, cClose);
                            int cCursor = 0;
                            while (cCursor < cellsChunk.length()) {
                                int cStart = cellsChunk.indexOf('{', cCursor);
                                if (cStart == -1) break;
                                int cEnd = cellsChunk.indexOf('}', cStart);
                                if (cEnd == -1) break;
                                String cellStr = cellsChunk.substring(cStart, cEnd + 1);
                                Integer r = parseIntField(cellStr, "r");
                                Integer c = parseIntField(cellStr, "c");
                                if (r != null && c != null) {
                                    ship.cells.add(new Cell(r, c));
                                }
                                cCursor = cEnd + 1;
                            }
                        }
                    }
                }
                fleet.add(ship);
            }
            cursor = objEnd + 1;
        }
        return fleet;
    }

    private static int findMatchingBrace(String s, int openIdx) {
        int depth = 0;
        for (int i = openIdx; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '{') depth++;
            else if (ch == '}') {
                depth--;
                if (depth == 0) return i;
            }
        }
        return -1;
    }

    private static void parseAndRestoreState(String json) {
        // Parse players
        int pIdx = json.indexOf("\"players\"");
        if (pIdx != -1) {
            int pOpen = json.indexOf('[', pIdx);
            int pClose = json.indexOf(']', pOpen);
            if (pOpen != -1 && pClose != -1) {
                String pStr = json.substring(pOpen + 1, pClose);
                int cur = 0;
                while (cur < pStr.length()) {
                    int start = pStr.indexOf('{', cur);
                    if (start == -1) break;
                    int end = pStr.indexOf('}', start);
                    if (end == -1) break;
                    String item = pStr.substring(start, end + 1);
                    String id = parseStringField(item, "id");
                    String name = parseStringField(item, "name");
                    Long createdAt = parseLongField(item, "createdAt");
                    if (id != null && name != null) {
                        players.put(id, new Player(id, name, createdAt != null ? createdAt : System.currentTimeMillis()));
                    }
                    cur = end + 1;
                }
            }
        }

        // Parse games
        int gIdx = json.indexOf("\"games\"");
        if (gIdx != -1) {
            int gOpen = json.indexOf('[', gIdx);
            if (gOpen != -1) {
                int cur = gOpen + 1;
                while (cur < json.length()) {
                    int gStart = json.indexOf('{', cur);
                    if (gStart == -1) break;
                    int gEnd = findMatchingBrace(json, gStart);
                    if (gEnd == -1) break;

                    String gChunk = json.substring(gStart, gEnd + 1);
                    String id = parseStringField(gChunk, "id");
                    String name = parseStringField(gChunk, "name");
                    String p1 = parseStringField(gChunk, "player1Id");
                    String p2 = parseStringField(gChunk, "player2Id");
                    String phase = parseStringField(gChunk, "phase");
                    String curTurn = parseStringField(gChunk, "currentTurnPlayerId");
                    String winner = parseStringField(gChunk, "winnerId");
                    Long createdAt = parseLongField(gChunk, "createdAt");
                    Long updatedAt = parseLongField(gChunk, "updatedAt");

                    if (id != null && p1 != null) {
                        Game g = new Game(name != null ? name : "Saved Battle", p1);
                        g.id = id;
                        g.player2Id = p2;
                        g.phase = phase != null ? phase : "waiting";
                        g.currentTurnPlayerId = curTurn;
                        g.winnerId = winner;
                        g.createdAt = createdAt != null ? createdAt : System.currentTimeMillis();
                        g.updatedAt = updatedAt != null ? updatedAt : g.createdAt;

                        // Parse boards
                        g.board1 = parseBoardFromChunk(gChunk, "board1");
                        g.board2 = parseBoardFromChunk(gChunk, "board2");

                        games.put(id, g);
                    }
                    cur = gEnd + 1;
                }
            }
        }
    }

    private static Board parseBoardFromChunk(String chunk, String fieldName) {
        int idx = chunk.indexOf("\"" + fieldName + "\"");
        if (idx == -1) return null;
        int objStart = chunk.indexOf('{', idx);
        if (objStart == -1) return null;
        int objEnd = findMatchingBrace(chunk, objStart);
        if (objEnd == -1) return null;
        String bChunk = chunk.substring(objStart, objEnd + 1);

        String playerId = parseStringField(bChunk, "playerId");
        if (playerId == null) return null;
        Board board = new Board(playerId);
        board.ready = bChunk.contains("\"ready\":true");
        board.ships = parseShipsFromJson(bChunk);

        // Parse shotsReceived
        int shIdx = bChunk.indexOf("\"shotsReceived\"");
        if (shIdx != -1) {
            int shOpen = bChunk.indexOf('[', shIdx);
            int shClose = bChunk.indexOf(']', shOpen);
            if (shOpen != -1 && shClose != -1) {
                String shotsStr = bChunk.substring(shOpen + 1, shClose);
                int cur = 0;
                while (cur < shotsStr.length()) {
                    int s1 = shotsStr.indexOf('{', cur);
                    if (s1 == -1) break;
                    int s2 = shotsStr.indexOf('}', s1);
                    if (s2 == -1) break;
                    String shChunk = shotsStr.substring(s1, s2 + 1);
                    Integer r = parseIntField(shChunk, "r");
                    Integer c = parseIntField(shChunk, "c");
                    String res = parseStringField(shChunk, "result");
                    String sId = parseStringField(shChunk, "shipId");
                    String sName = parseStringField(shChunk, "shipName");
                    boolean sunk = shChunk.contains("\"sunk\":true");
                    if (r != null && c != null && res != null) {
                        board.shotsReceived.add(new Shot(r, c, res, sId, sName, sunk));
                    }
                    cur = s2 + 1;
                }
            }
        }
        return board;
    }

    private static Long parseLongField(String json, String field) {
        int idx = json.indexOf("\"" + field + "\"");
        if (idx == -1) return null;
        int colon = json.indexOf(':', idx);
        if (colon == -1) return null;
        int start = colon + 1;
        while (start < json.length() && Character.isWhitespace(json.charAt(start))) start++;
        int end = start;
        while (end < json.length() && Character.isDigit(json.charAt(end))) end++;
        if (start == end) return null;
        try {
            return Long.parseLong(json.substring(start, end));
        } catch (Exception e) {
            return null;
        }
    }
}

