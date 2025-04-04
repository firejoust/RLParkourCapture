package com.firejoust.parkourcapture;

import com.google.common.collect.ImmutableSet;
import com.google.gson.annotations.SerializedName;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

import java.util.Set;

// Record definition remains the same
public record ParkourTickData(
    // ... (all existing fields remain the same) ...
    @SerializedName("f") boolean inputForward,
    @SerializedName("l") boolean inputLeft,
    @SerializedName("r") boolean inputRight,
    @SerializedName("b") boolean inputBack,
    @SerializedName("j") boolean inputJump,
    @SerializedName("n") boolean inputSneak,
    @SerializedName("s") boolean inputSprint,
    @SerializedName("y") float yaw,
    @SerializedName("vx") double velocityX,
    @SerializedName("vy") double velocityY,
    @SerializedName("vz") double velocityZ,
    @SerializedName("g") boolean isOnGround,
    @SerializedName("ch") boolean isCollidedHorizontally,
    @SerializedName("cv") boolean isCollidedVertically,
    @SerializedName("py") double playerY,
    @SerializedName("vd") float[][] visionDistanceGrid,
    @SerializedName("vb") int[][] visionBlockStateGrid,
    @SerializedName("fz") boolean isInFallZone
) {

    // --- Vision Grid Constants (Unchanged) ---
    private static final int VISION_GRID_WIDTH = 36;
    private static final float VISION_FOV_DEGREES = 120.0f;
    private static final float VERTICAL_FOV_DEGREES = 180.0f;
    private static final float MAX_RAYCAST_DISTANCE = 64.0f;
    private static final int VISION_GRID_HEIGHT = calculateVisionGridHeight();

    // --- Set of Special Blocks to Check After Outline Hit ---
    // These are the blocks we prioritize if hit by the OUTLINE raycast.
    private static final Set<Block> SPECIAL_NON_COLLIDABLE_BLOCKS = ImmutableSet.of(
            Blocks.LADDER,
            Blocks.VINE,
            Blocks.TWISTING_VINES,
            Blocks.TWISTING_VINES_PLANT,
            Blocks.WEEPING_VINES,
            Blocks.WEEPING_VINES_PLANT,
            Blocks.WATER,
            Blocks.LAVA,
            Blocks.COBWEB
            // Slime, Soul Sand, Ice, Honey have collision, COLLIDER should hit them.
    );

    // Helper method to calculate height (Unchanged)
    private static int calculateVisionGridHeight() {
        if (VISION_FOV_DEGREES <= 0) {
            System.err.println("ERROR: VISION_FOV_DEGREES must be positive for height calculation!");
            return 1;
        }
        float calculatedHeight = (VISION_GRID_WIDTH * VERTICAL_FOV_DEGREES) / VISION_FOV_DEGREES;
        return Math.round(calculatedHeight);
    }

    // Factory method signature remains the same
    public static ParkourTickData capture(MinecraftClient client, int targetFallY, double lastTickVelocityY) {
        ClientPlayerEntity player = client.player;
        if (player == null || client.world == null) {
            return null;
        }

        // --- Inputs, Orientation, Movement, State, Position (Unchanged) ---
        boolean inputForward = client.options.forwardKey.isPressed();
        boolean inputLeft = client.options.leftKey.isPressed();
        boolean inputRight = client.options.rightKey.isPressed();
        boolean inputBack = client.options.backKey.isPressed();
        boolean inputJump = client.options.jumpKey.isPressed();
        boolean inputSneak = client.options.sneakKey.isPressed();
        boolean inputSprint = client.options.sprintKey.isPressed();
        float yaw = player.getYaw();
        Vec3d velocity = player.getVelocity();
        double velocityX = velocity.x;
        double velocityY = velocity.y;
        double velocityZ = velocity.z;
        boolean isOnGround = player.isOnGround();
        boolean isCollidedHorizontally = player.horizontalCollision;
        boolean isCollidedVertically = player.verticalCollision;
        double playerY = player.getY();

        // --- Vision ---
        // Now uses the modified performVisionRaycasts with two-stage raycasting
        VisionResult visionResult = performVisionRaycasts(client, player);

        // --- Parkour Targets (Unchanged) ---
        boolean isInFallZone = velocityY <= 0.0 && isOnGround && player.getY() <= (targetFallY + 1.0);

        // Constructor call remains the same
        return new ParkourTickData(
            inputForward, inputLeft, inputRight, inputBack, inputJump, inputSneak, inputSprint,
            yaw,
            velocityX, velocityY, velocityZ,
            isOnGround, isCollidedHorizontally, isCollidedVertically,
            playerY,
            visionResult.distanceGrid, visionResult.blockStateGrid,
            isInFallZone
        );
    }

    // Internal record for results (Unchanged)
    private record VisionResult(float[][] distanceGrid, int[][] blockStateGrid) {}

    // --- MODIFIED: performVisionRaycasts uses two-stage raycasting ---
    private static VisionResult performVisionRaycasts(MinecraftClient client, ClientPlayerEntity player) {
        float[][] distances = new float[VISION_GRID_HEIGHT][VISION_GRID_WIDTH];
        int[][] blockStates = new int[VISION_GRID_HEIGHT][VISION_GRID_WIDTH];
        ClientWorld world = client.world;

        if (world == null) {
             return new VisionResult(distances, blockStates);
        }

        Vec3d eyePos = player.getCameraPosVec(1.0f);
        float playerYawRad = (float) Math.toRadians(player.getYaw());
        float playerPitchRad = 0.0f; // Fixed pitch

        float horizontalFovRad = (float) Math.toRadians(VISION_FOV_DEGREES);
        float verticalFovRad = (float) Math.toRadians(VERTICAL_FOV_DEGREES);
        float yawStepRad = horizontalFovRad / VISION_GRID_WIDTH;
        float pitchStepRad = (VISION_GRID_HEIGHT > 0) ? (verticalFovRad / VISION_GRID_HEIGHT) : 0;
        float startYawOffset = -horizontalFovRad / 2.0f + yawStepRad / 2.0f;
        float startPitchOffset = -verticalFovRad / 2.0f + pitchStepRad / 2.0f;

        for (int r = 0; r < VISION_GRID_HEIGHT; r++) {
            for (int c = 0; c < VISION_GRID_WIDTH; c++) {
                float rayYawRad = playerYawRad + startYawOffset + c * yawStepRad;
                float rayPitchRad = playerPitchRad + startPitchOffset + r * pitchStepRad;
                rayPitchRad = MathHelper.clamp(rayPitchRad, -(float)Math.PI / 2.0f + 0.001f, (float)Math.PI / 2.0f - 0.001f);

                float cosPitch = MathHelper.cos(rayPitchRad);
                float sinPitch = MathHelper.sin(rayPitchRad);
                float cosYaw = MathHelper.cos(rayYawRad);
                float sinYaw = MathHelper.sin(rayYawRad);

                Vec3d direction = new Vec3d(-sinYaw * cosPitch, -sinPitch, cosYaw * cosPitch).normalize();
                Vec3d endPos = eyePos.add(direction.multiply(MAX_RAYCAST_DISTANCE));

                boolean specialBlockHit = false;

                // 1. Raycast using OUTLINE shape first, including fluids
                RaycastContext contextOutline = new RaycastContext(
                    eyePos,
                    endPos,
                    RaycastContext.ShapeType.OUTLINE, // Use outline shape
                    RaycastContext.FluidHandling.ANY,   // Detect any fluid
                    player
                );
                BlockHitResult hitOutline = world.raycast(contextOutline);

                if (hitOutline.getType() == HitResult.Type.BLOCK) {
                    BlockPos blockPos = hitOutline.getBlockPos();
                    BlockState blockState = world.getBlockState(blockPos);
                    // Check if the hit block is one of our special types
                    if (SPECIAL_NON_COLLIDABLE_BLOCKS.contains(blockState.getBlock())) {
                        // It's a special block, record this hit and skip the COLLIDER check
                        distances[r][c] = (float) hitOutline.getPos().distanceTo(eyePos);
                        blockStates[r][c] = Block.getRawIdFromState(blockState);
                        specialBlockHit = true;
                        // continue; // Go to next grid cell (r, c loop)
                    }
                    // If it hit something but wasn't special, we'll proceed to the COLLIDER check
                }

                // 2. If no special block was hit by the OUTLINE raycast, perform standard COLLIDER raycast
                if (!specialBlockHit) {
                    RaycastContext contextCollider = new RaycastContext(
                        eyePos,
                        endPos,
                        RaycastContext.ShapeType.COLLIDER, // Use standard collision shape
                        RaycastContext.FluidHandling.NONE,    // Ignore fluids here (handled above if special)
                        player
                    );
                    BlockHitResult hitCollider = world.raycast(contextCollider);

                    if (hitCollider.getType() == HitResult.Type.BLOCK) {
                        // Hit a standard collidable block
                        BlockPos blockPos = hitCollider.getBlockPos();
                        distances[r][c] = (float) hitCollider.getPos().distanceTo(eyePos);
                        blockStates[r][c] = Block.getRawIdFromState(world.getBlockState(blockPos));
                    } else {
                        // Both OUTLINE (for special) and COLLIDER missed
                        distances[r][c] = MAX_RAYCAST_DISTANCE;
                        blockStates[r][c] = 0; // Air
                    }
                }
                // If specialBlockHit was true, we already recorded the data and implicitly skip this COLLIDER check part.
            }
        }
        return new VisionResult(distances, blockStates);
    }

    // Manual stepping code (findFirstSpecialBlockAlongRay, ManualHitResult) is removed.

     // toString remains the same (Unchanged)
     @Override
     public String toString() {
         // ... (toString code is unchanged) ...
         return "ParkourTickData{" +
                "input=" + (inputForward?"F":"") + (inputLeft?"L":"") + (inputRight?"R":"") + (inputBack?"B":"") + (inputJump?"J":"") + (inputSneak?"N":"") + (inputSprint?"S":"") +
                ", yaw=" + String.format("%.1f", yaw) +
                ", vel=(" + String.format("%.2f", velocityX) + "," + String.format("%.2f", velocityY) + "," + String.format("%.2f", velocityZ) + ")" +
                ", onGround=" + isOnGround +
                ", playerY=" + String.format("%.2f", playerY) +
                ", isInFallZone=" + isInFallZone +
                '}';
     }
}