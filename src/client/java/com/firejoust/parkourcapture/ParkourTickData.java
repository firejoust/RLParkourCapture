package com.firejoust.parkourcapture;

import com.google.gson.annotations.SerializedName;
import net.minecraft.block.Block;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

// --- MODIFIED Record Definition ---
// Removed targetBearingYaw and fallZoneY fields
public record ParkourTickData(
    // Input (i)
    @SerializedName("f") boolean inputForward,
    @SerializedName("l") boolean inputLeft,
    @SerializedName("r") boolean inputRight,
    @SerializedName("b") boolean inputBack,
    @SerializedName("j") boolean inputJump,
    @SerializedName("n") boolean inputSneak, // 'n' for sNeak
    @SerializedName("s") boolean inputSprint,
    // Orientation (o)
    @SerializedName("y") float yaw,
    @SerializedName("p") float pitch,
    // Movement (m)
    @SerializedName("vx") double velocityX,
    @SerializedName("vy") double velocityY,
    @SerializedName("vz") double velocityZ,
    // State (st)
    @SerializedName("g") boolean isOnGround, // 'g' for Ground
    @SerializedName("ch") boolean isCollidedHorizontally,
    @SerializedName("cv") boolean isCollidedVertically,
    // Position (pos)
    @SerializedName("py") double playerY,
    // Vision (v)
    @SerializedName("vd") float[][] visionDistanceGrid, // vision distance
    @SerializedName("vb") int[][] visionBlockStateGrid, // vision block state
    // Parkour Targets (t) - Only isInFallZone remains here
    @SerializedName("fz") boolean isInFallZone // 'fz' for Fall Zone
) {

    // Constants for vision grid
    private static final int VISION_GRID_WIDTH = 32;
    private static final int VISION_GRID_HEIGHT = 18;
    private static final float VISION_FOV_DEGREES = 120.0f;
    private static final float MAX_RAYCAST_DISTANCE = 64.0f;

    // --- MODIFIED Factory Method Signature ---
    // Takes targetFallY for calculation, but doesn't store it in the record fields
    public static ParkourTickData capture(MinecraftClient client, int targetFallY, double lastTickVelocityY) {
        ClientPlayerEntity player = client.player;
        if (player == null || client.world == null) {
            return null;
        }

        // --- Inputs ---
        boolean inputForward = client.options.forwardKey.isPressed();
        boolean inputLeft = client.options.leftKey.isPressed();
        boolean inputRight = client.options.rightKey.isPressed();
        boolean inputBack = client.options.backKey.isPressed();
        boolean inputJump = client.options.jumpKey.isPressed();
        boolean inputSneak = client.options.sneakKey.isPressed();
        boolean inputSprint = client.options.sprintKey.isPressed();

        // --- Orientation ---
        float yaw = player.getYaw();
        float pitch = player.getPitch();

        // --- Movement ---
        Vec3d velocity = player.getVelocity();
        double velocityX = velocity.x;
        double velocityY = velocity.y;
        double velocityZ = velocity.z;

        // --- State ---
        boolean isOnGround = player.isOnGround();
        boolean isCollidedHorizontally = player.horizontalCollision;
        boolean isCollidedVertically = player.verticalCollision;

        // --- Position ---
        double playerY = player.getY();

        // --- Vision ---
        VisionResult visionResult = performVisionRaycasts(client, player);

        // --- Parkour Targets ---
        // Uses the targetFallY parameter directly for calculation
        boolean isInFallZone = velocityY <= 0.0 && isOnGround && player.getY() <= (targetFallY + 1.0);

        // --- MODIFIED Constructor Call ---
        // Omits targetBearingYaw and fallZoneY
        return new ParkourTickData(
            inputForward, inputLeft, inputRight, inputBack, inputJump, inputSneak, inputSprint,
            yaw, pitch,
            velocityX, velocityY, velocityZ,
            isOnGround, isCollidedHorizontally, isCollidedVertically,
            playerY,
            visionResult.distanceGrid, visionResult.blockStateGrid,
            // Only isInFallZone remains from the target section
            isInFallZone
        );
    }

    // VisionResult and performVisionRaycasts remain the same as before
    private record VisionResult(float[][] distanceGrid, int[][] blockStateGrid) {}

    private static VisionResult performVisionRaycasts(MinecraftClient client, ClientPlayerEntity player) {
        float[][] distances = new float[VISION_GRID_HEIGHT][VISION_GRID_WIDTH];
        int[][] blockStates = new int[VISION_GRID_HEIGHT][VISION_GRID_WIDTH];

        Vec3d eyePos = player.getCameraPosVec(1.0f);
        float playerYawRad = (float) Math.toRadians(player.getYaw());
        float playerPitchRad = (float) Math.toRadians(player.getPitch());

        float fovRad = (float) Math.toRadians(VISION_FOV_DEGREES);
        float yawStepRad = fovRad / VISION_GRID_WIDTH;
        float verticalFovRad = fovRad * ((float)VISION_GRID_HEIGHT / VISION_GRID_WIDTH);
        float pitchStepRad = verticalFovRad / VISION_GRID_HEIGHT;

        float startYawOffset = -fovRad / 2.0f + yawStepRad / 2.0f;
        float startPitchOffset = -verticalFovRad / 2.0f + pitchStepRad / 2.0f;

        for (int r = 0; r < VISION_GRID_HEIGHT; r++) {
            for (int c = 0; c < VISION_GRID_WIDTH; c++) {
                float rayYawRad = playerYawRad + startYawOffset + c * yawStepRad;
                float rayPitchRad = playerPitchRad + startPitchOffset + r * pitchStepRad;

                float cosPitch = MathHelper.cos(rayPitchRad);
                float sinPitch = MathHelper.sin(rayPitchRad);
                float cosYaw = MathHelper.cos(rayYawRad);
                float sinYaw = MathHelper.sin(rayYawRad);

                Vec3d direction = new Vec3d(-sinYaw * cosPitch, -sinPitch, cosYaw * cosPitch);
                Vec3d endPos = eyePos.add(direction.multiply(MAX_RAYCAST_DISTANCE));

                RaycastContext context = new RaycastContext(
                    eyePos,
                    endPos,
                    RaycastContext.ShapeType.COLLIDER,
                    RaycastContext.FluidHandling.NONE,
                    player
                );

                BlockHitResult hitResult = client.world.raycast(context);

                if (hitResult.getType() == HitResult.Type.BLOCK) {
                    BlockPos blockPos = hitResult.getBlockPos();
                    distances[r][c] = (float) hitResult.getPos().distanceTo(eyePos);
                    blockStates[r][c] = Block.getRawIdFromState(client.world.getBlockState(blockPos));
                } else {
                    distances[r][c] = MAX_RAYCAST_DISTANCE;
                    blockStates[r][c] = 0;
                }
            }
        }
        return new VisionResult(distances, blockStates);
    }

     // toString updated to remove target fields
     @Override
     public String toString() {
         return "ParkourTickData{" +
                "input=" + (inputForward?"F":"") + (inputLeft?"L":"") + (inputRight?"R":"") + (inputBack?"B":"") + (inputJump?"J":"") + (inputSneak?"N":"") + (inputSprint?"S":"") +
                ", yaw=" + String.format("%.1f", yaw) +
                ", pitch=" + String.format("%.1f", pitch) +
                ", vel=(" + String.format("%.2f", velocityX) + "," + String.format("%.2f", velocityY) + "," + String.format("%.2f", velocityZ) + ")" +
                ", onGround=" + isOnGround +
                ", playerY=" + String.format("%.2f", playerY) +
                ", isInFallZone=" + isInFallZone +
                '}';
     }
}