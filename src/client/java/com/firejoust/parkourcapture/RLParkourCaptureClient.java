package com.firejoust.parkourcapture;

import com.firejoust.parkourcapture.util.DoubleSerializer;
import com.firejoust.parkourcapture.util.FloatSerializer;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.annotations.SerializedName;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;
import net.minecraft.util.math.MathHelper;
import org.lwjgl.glfw.GLFW;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.FileWriter;
import java.io.IOException;
import java.io.Writer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap; // Use LinkedHashMap to preserve insertion order for mappings
import java.util.List;
import java.util.Map;

public class RLParkourCaptureClient implements ClientModInitializer {

    public static final Logger LOGGER = LoggerFactory.getLogger("ParkourCapture");
    private static final String MOD_ID = "parkourcapture";
    private static final String KEY_CATEGORY = "key.categories." + MOD_ID;

    private static KeyBinding keyToggleRecording;
    // Removed: private static KeyBinding keySetTargetYaw;
    private static KeyBinding keySetFallZoneY;

    private boolean isRecording = false;
    private long recordingStartTimeMillis = 0;
    private List<ParkourTickData> recordedData = new ArrayList<>();
    private Float targetBearingYaw = null; // Will be set automatically on recording start
    private Integer fallZoneY = null;
    private double lastPlayerVelocityY = 0.0;

    // Fall zone warning
    private static final int WARNING_INTERVAL_TICKS = 100;
    // --- MODIFIED: Reduced warning threshold ---
    private static final double WARNING_DISTANCE_THRESHOLD = 8.0; // Was 10.0
    private long lastWarningTick = 0;

    private static final Gson GSON = new GsonBuilder()
            .registerTypeAdapter(Double.class, new DoubleSerializer())
            .registerTypeAdapter(Float.class, new FloatSerializer())
            // .setPrettyPrinting() // Optional: Keep for readability
            .create();

    private static final Path SAVE_DIR = FabricLoader.getInstance().getGameDir().resolve("parkour_data");

    @Override
    public void onInitializeClient() {
        LOGGER.info("Initializing Parkour Data Capture Mod");

        keyToggleRecording = KeyBindingHelper.registerKeyBinding(new KeyBinding(
                "key." + MOD_ID + ".toggle_recording", InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_F8, KEY_CATEGORY));
        // Removed: keySetTargetYaw = KeyBindingHelper.registerKeyBinding(new KeyBinding(
        //        "key." + MOD_ID + ".set_target_yaw", InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_F9, KEY_CATEGORY));
        keySetFallZoneY = KeyBindingHelper.registerKeyBinding(new KeyBinding(
                "key." + MOD_ID + ".set_fall_zone_y", InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_F10, KEY_CATEGORY)); // Kept F10 for Fall Zone Y

        ClientTickEvents.END_CLIENT_TICK.register(this::onClientTick);

        try {
            Files.createDirectories(SAVE_DIR);
        } catch (IOException e) {
            LOGGER.error("Failed to create save directory: {}", SAVE_DIR, e);
        }
    }

    private void onClientTick(MinecraftClient client) {
        if (client.player == null || client.world == null) {
            if (isRecording) {
                LOGGER.warn("Player or world became null while recording. Stopping recording.");
                stopRecording(client, false);
            }
            return;
        }

        handleKeybindings(client);

        if (isRecording) {
            // --- MODIFIED Call to capture ---
            // Pass fallZoneY for calculation, pitch is handled internally in ParkourTickData
            ParkourTickData tickData = ParkourTickData.capture(client, fallZoneY, lastPlayerVelocityY);
            if (tickData != null) {
                recordedData.add(tickData);
                lastPlayerVelocityY = tickData.velocityY(); // Still need Y velocity for fall zone check logic
            } else {
                 LOGGER.error("Failed to capture tick data!");
            }
            checkAndSendFallZoneWarning(client);
        }
    }

    // --- MODIFIED: Removed target yaw key check ---
    private void handleKeybindings(MinecraftClient client) {
        while (keyToggleRecording.wasPressed()) {
            toggleRecording(client);
        }
        // Removed: while (keySetTargetYaw.wasPressed()) { setTargetYaw(client); }
        while (keySetFallZoneY.wasPressed()) {
            setFallZoneY(client);
        }
    }

    private void toggleRecording(MinecraftClient client) {
        if (isRecording) {
            stopRecording(client, true);
        } else {
            startRecording(client);
        }
    }

    // --- MODIFIED: Automatically set target yaw, removed check ---
    private void startRecording(MinecraftClient client) {
        // Removed check: if (targetBearingYaw == null) { ... }
        if (fallZoneY == null) {
            sendMessage(client, "Cannot start recording: Fall Zone Y not set.", Formatting.RED);
            return;
        }
        if (client.player == null) {
             sendMessage(client, "Cannot start recording: Player not available.", Formatting.RED);
             return;
        }

        // --- Automatically set target yaw ---
        targetBearingYaw = client.player.getYaw();
        sendMessage(client, String.format("Target Bearing Yaw automatically set to: %.1f", targetBearingYaw), Formatting.AQUA);
        LOGGER.info("Target Bearing Yaw automatically set: {}", String.format("%.1f", targetBearingYaw));

        isRecording = true;
        recordedData.clear();
        lastPlayerVelocityY = client.player.getVelocity().y;
        lastWarningTick = client.world.getTime();
        recordingStartTimeMillis = System.currentTimeMillis();
        sendMessage(client, "Started parkour data recording.", Formatting.GREEN);
        LOGGER.info("Recording started. Target Yaw: {}, Fall Zone Y: {}", String.format("%.1f", targetBearingYaw), fallZoneY);
    }

    private void stopRecording(MinecraftClient client, boolean saveData) {
        if (!isRecording) return;

        isRecording = false;
        sendMessage(client, "Stopped parkour data recording.", Formatting.YELLOW);
        LOGGER.info("Recording stopped. {} ticks captured.", recordedData.size());

        if (saveData && !recordedData.isEmpty()) {
            filterData();
            saveDataToFile(client);
        } else if (saveData && recordedData.isEmpty()) {
             sendMessage(client, "No data recorded.", Formatting.GRAY);
        }
        recordedData.clear();
        recordingStartTimeMillis = 0;
        targetBearingYaw = null; // Reset auto-set yaw
    }

    // --- REMOVED setTargetYaw method ---
    // private void setTargetYaw(MinecraftClient client) { ... }

    // --- MODIFIED: Prevent setting while recording ---
    private void setFallZoneY(MinecraftClient client) {
         if (isRecording) {
            sendMessage(client, "Cannot set Fall Zone Y while recording is active.", Formatting.RED);
            return;
        }
        if (client.player != null) {
            fallZoneY = MathHelper.floor(client.player.getY());
            sendMessage(client, "Fall Zone Y set to: " + fallZoneY, Formatting.AQUA);
             LOGGER.info("Fall Zone Y set: {}", fallZoneY);
        }
    }

    private void filterData() {
        if (recordedData.isEmpty()) return;

        int lastOnGroundIndex = -1;
        for (int i = recordedData.size() - 1; i >= 0; i--) {
            if (recordedData.get(i).isOnGround()) {
                lastOnGroundIndex = i;
                break;
            }
        }

        if (lastOnGroundIndex != -1 && lastOnGroundIndex < recordedData.size() - 1) {
            int removedCount = recordedData.size() - (lastOnGroundIndex + 1);
            recordedData = new ArrayList<>(recordedData.subList(0, lastOnGroundIndex + 1));
            LOGGER.info("Filtered data: Removed {} ticks after last ground contact.", removedCount);
        } else {
             LOGGER.info("No filtering needed or no ground contact found after start.");
        }
    }

     private void saveDataToFile(MinecraftClient client) {
        if (recordedData.isEmpty()) {
            LOGGER.warn("Attempted to save empty dataset.");
            sendMessage(client, "No data to save.", Formatting.GRAY);
            return;
        }
        // Ensure targetBearingYaw was set (should be by startRecording)
        if (targetBearingYaw == null) {
             LOGGER.error("Attempted to save data but targetBearingYaw is null!");
             sendMessage(client, "Error saving: Target Yaw was not set (Internal Error).", Formatting.RED);
             return;
        }

        String timestamp = new SimpleDateFormat("yyyyMMdd_HHmmss").format(new Date());
        String serverIp = (client.getCurrentServerEntry() != null ? client.getCurrentServerEntry().address : "Singleplayer")
                            .replaceAll("[^a-zA-Z0-9.-]", "_");
        String filename = String.format("%s_%s.json", serverIp, timestamp);
        Path filePath = SAVE_DIR.resolve(filename);

        // --- Create Key Mappings (Updated) ---
        Map<String, String> keyMappings = new LinkedHashMap<>(); // Use LinkedHashMap to keep order
        // Top Level Keys
        keyMappings.put("ts", "startTimestampMillis");
        keyMappings.put("te", "stopTimestampMillis");
        keyMappings.put("ip", "serverIp");
        keyMappings.put("ty", "targetBearingYaw"); // Still relevant for the run metadata
        keyMappings.put("tfy", "targetFallZoneY");
        keyMappings.put("map", "keyMappings"); // Mapping for the map itself
        keyMappings.put("d", "tickDataList");
        // Tick Data Keys (Pitch removed)
        keyMappings.put("f", "inputForward");
        keyMappings.put("l", "inputLeft");
        keyMappings.put("r", "inputRight");
        keyMappings.put("b", "inputBack");
        keyMappings.put("j", "inputJump");
        keyMappings.put("n", "inputSneak");
        keyMappings.put("s", "inputSprint");
        keyMappings.put("y", "playerYaw");
        // keyMappings.put("p", "playerPitch"); // Removed pitch mapping
        keyMappings.put("vx", "velocityX");
        keyMappings.put("vy", "velocityY");
        keyMappings.put("vz", "velocityZ");
        keyMappings.put("g", "isOnGround");
        keyMappings.put("ch", "isCollidedHorizontally");
        keyMappings.put("cv", "isCollidedVertically");
        keyMappings.put("py", "playerY");
        keyMappings.put("vd", "visionDistanceGrid");
        keyMappings.put("vb", "visionBlockStateGrid");
        keyMappings.put("fz", "isInFallZone");


        // --- Create Run Data Object ---
        // ParkourRunData still includes targetBearingYaw as run metadata
        ParkourRunData runData = new ParkourRunData(
                recordingStartTimeMillis,
                System.currentTimeMillis(),
                serverIp,
                targetBearingYaw, // Use the automatically set yaw
                fallZoneY,
                keyMappings, // Add the mappings
                recordedData
        );

        try (Writer writer = new FileWriter(filePath.toFile())) {
            GSON.toJson(runData, writer);
            sendMessage(client, "Parkour data saved to: " + filename, Formatting.GREEN);
            LOGGER.info("Data saved successfully to {}", filePath);
        } catch (IOException e) {
            sendMessage(client, "Error saving parkour data! (I/O Error)", Formatting.RED);
            LOGGER.error("Failed to write parkour data to file: {}", filePath, e);
        } catch (com.google.gson.JsonIOException | com.google.gson.JsonSyntaxException gsonEx) {
             sendMessage(client, "Error saving parkour data! (JSON Error)", Formatting.RED);
             LOGGER.error("Failed to serialize parkour data to JSON", gsonEx);
        } catch (Exception e) {
            sendMessage(client, "An unexpected error occurred while saving data!", Formatting.RED);
            LOGGER.error("Unexpected error during parkour data saving", e);
        }
    }

    // --- ParkourRunData Record ---
    // No changes needed here, targetBearingYaw is run metadata
    private record ParkourRunData(
        @SerializedName("ts") long startTimestampMillis,
        @SerializedName("te") long stopTimestampMillis,
        @SerializedName("ip") String serverIp,
        @SerializedName("ty") float targetBearingYaw,
        @SerializedName("tfy") int fallZoneY,
        @SerializedName("map") Map<String, String> keyMappings,
        @SerializedName("d") List<ParkourTickData> ticks // Ticks list now contains data without pitch
    ) {}


    private void checkAndSendFallZoneWarning(MinecraftClient client) {
        if (client.player == null || client.world == null || fallZoneY == null || !isRecording) return;

        long currentTick = client.world.getTime();
        if (currentTick >= lastWarningTick + WARNING_INTERVAL_TICKS) {
            double playerY = client.player.getY();
            // Uses the updated WARNING_DISTANCE_THRESHOLD (8.0)
            if (Math.abs(playerY - fallZoneY) >= WARNING_DISTANCE_THRESHOLD) {
                sendMessage(client, String.format("Warning: Vertical distance to fall zone (%.1f) >= %.1f",
                        Math.abs(playerY - fallZoneY), WARNING_DISTANCE_THRESHOLD), Formatting.YELLOW);
                lastWarningTick = currentTick;
            }
            // Optional: Update lastWarningTick every interval regardless of warning
            // lastWarningTick = currentTick;
        }
    }

    private void sendMessage(MinecraftClient client, String message, Formatting color) {
        if (client.player != null) {
            client.player.sendMessage(Text.literal("[Parkour] ").formatted(Formatting.GOLD)
                    .append(Text.literal(message).formatted(color)), false);
        }
    }
}