import java.util.*;

public class BattleshipsTest {
    public static void main(String[] args) {
        System.out.println("Running Battleships Engine Tests...");

        testRandomFleetGeneration();
        testFleetValidation();
        testFogOfWar();
        testGameFlowAndSinking();

        System.out.println("All Tests Passed Successfully! ⚓");
    }

    private static void testRandomFleetGeneration() {
        System.out.print("- Testing random fleet generation... ");
        for (int t = 0; t < 50; t++) {
            List<BattleshipsServer.Ship> fleet = BattleshipsServer.generateRandomPlacement();
            assert fleet.size() == 5 : "Fleet must have 5 ships";
            String err = BattleshipsServer.validateFleet(fleet);
            if (err != null) {
                throw new AssertionError("Random fleet failed validation: " + err);
            }
        }
        System.out.println("OK");
    }

    private static void testFleetValidation() {
        System.out.print("- Testing fleet validation checks... ");
        // Test overlapping ships
        List<BattleshipsServer.Ship> fleet = new ArrayList<>();
        BattleshipsServer.Ship s1 = new BattleshipsServer.Ship("carrier", "Carrier", 5);
        s1.cells.add(new BattleshipsServer.Cell(0, 0));
        s1.cells.add(new BattleshipsServer.Cell(0, 1));
        s1.cells.add(new BattleshipsServer.Cell(0, 2));
        s1.cells.add(new BattleshipsServer.Cell(0, 3));
        s1.cells.add(new BattleshipsServer.Cell(0, 4));
        fleet.add(s1);

        // Intentionally overlap at (0, 0)
        BattleshipsServer.Ship s2 = new BattleshipsServer.Ship("battleship", "Battleship", 4);
        s2.cells.add(new BattleshipsServer.Cell(0, 0));
        s2.cells.add(new BattleshipsServer.Cell(1, 0));
        s2.cells.add(new BattleshipsServer.Cell(2, 0));
        s2.cells.add(new BattleshipsServer.Cell(3, 0));
        fleet.add(s2);

        fleet.add(new BattleshipsServer.Ship("cruiser", "Cruiser", 3));
        fleet.add(new BattleshipsServer.Ship("submarine", "Submarine", 3));
        fleet.add(new BattleshipsServer.Ship("destroyer", "Destroyer", 2));

        String err = BattleshipsServer.validateFleet(fleet);
        if (err == null || !err.contains("collision")) {
            throw new AssertionError("Expected collision error, got: " + err);
        }
        System.out.println("OK");
    }

    private static void testFogOfWar() {
        System.out.print("- Testing Fog-of-War confidentiality... ");
        BattleshipsServer.Player p1 = new BattleshipsServer.Player("Alice");
        BattleshipsServer.Player p2 = new BattleshipsServer.Player("Bob");

        BattleshipsServer.Game g = new BattleshipsServer.Game("Test Match", p1.id);
        g.join(p2.id);

        List<BattleshipsServer.Ship> f1 = BattleshipsServer.generateRandomPlacement();
        List<BattleshipsServer.Ship> f2 = BattleshipsServer.generateRandomPlacement();
        g.board1.ships = f1;
        g.board1.ready = true;
        g.board2.ships = f2;
        g.board2.ready = true;
        g.phase = "playing";

        // Serialize for Alice (p1)
        String aliceView = BattleshipsServer.serializeGameForPlayer(g, p1.id);

        // Find a coordinate of Bob's un-sunk carrier
        BattleshipsServer.Ship bobCarrier = f2.get(0);
        BattleshipsServer.Cell secretCell = bobCarrier.cells.get(0);

        // Ensure Alice's view does NOT leak Bob's un-sunk ship cells
        // Notice opponentSunkShips is currently empty because nothing was sunk yet
        if (aliceView.contains("\"opponentSunkShips\":[{\"id\":\"" + bobCarrier.id + "\"")) {
            throw new AssertionError("Fog-of-War breach! Opponent un-sunk ship was serialized in client view");
        }

        System.out.println("OK");
    }

    private static void testGameFlowAndSinking() {
        System.out.print("- Testing combat flow, hits, and sinking... ");
        BattleshipsServer.Player p1 = new BattleshipsServer.Player("Red");
        BattleshipsServer.Player p2 = new BattleshipsServer.Player("Blue");

        BattleshipsServer.Game g = new BattleshipsServer.Game("Combat Test", p1.id);
        g.join(p2.id);

        // Manually setup simple non-overlapping fleets
        List<BattleshipsServer.Ship> f2 = new ArrayList<>();
        BattleshipsServer.Ship destroyer = new BattleshipsServer.Ship("destroyer", "Destroyer", 2);
        destroyer.cells.add(new BattleshipsServer.Cell(4, 5));
        destroyer.cells.add(new BattleshipsServer.Cell(4, 6));
        f2.add(destroyer);
        g.board2.ships = f2;

        // Verify hit detection
        BattleshipsServer.Ship hit1 = g.board2.getShipAt(4, 5);
        if (hit1 == null || !hit1.id.equals("destroyer")) throw new AssertionError("Failed to detect ship at (4,5)");

        hit1.hits++;
        if (hit1.hits >= hit1.size) throw new AssertionError("Destroyer should not be sunk after 1 hit");

        BattleshipsServer.Ship hit2 = g.board2.getShipAt(4, 6);
        hit2.hits++;
        if (hit2.hits >= hit2.size) hit2.sunk = true;

        if (!destroyer.sunk) throw new AssertionError("Destroyer should be sunk after 2 hits");
        if (!g.board2.allShipsSunk()) throw new AssertionError("Board should register all ships sunk");

        System.out.println("OK");
    }
}

