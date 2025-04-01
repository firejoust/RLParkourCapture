package com.firejoust.parkourcapture.util;

import com.google.gson.*;
import java.lang.reflect.Type;
import java.math.BigDecimal;
import java.math.RoundingMode;

public class FloatSerializer implements JsonSerializer<Float> {
    @Override
    public JsonElement serialize(Float src, Type typeOfSrc, JsonSerializationContext context) {
        if (src == null) {
            return JsonNull.INSTANCE;
        }
        if (src.isNaN() || src.isInfinite()) {
            // Represent NaN/Infinity as strings, as JSON numbers can't handle them
            return new JsonPrimitive(src.toString());
        }
        // Use BigDecimal for precise rounding control
        BigDecimal bd = BigDecimal.valueOf(src.doubleValue()).setScale(3, RoundingMode.HALF_UP);
        return new JsonPrimitive(bd);
    }
}