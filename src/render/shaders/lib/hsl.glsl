// Banded hue, saturation and luminance. Reference: src/core/colour/hsl.ts.
//
// Every operation here is EXACTLY the identity at zero, and that is the design
// rather than a happy property. A round trip through an HSL model is not
// bit-exact, so the moment one band is adjusted every pixel would go through the
// conversion and the untouched bands would come back changed.

#ifndef HSL_GLSL
#define HSL_GLSL

const int HSL_BAND_COUNT = 6;
const float HSL_BAND_SPACING = 60.0;
const vec3 HSL_AP1_LUMINANCE = vec3(0.2722, 0.6741, 0.0537);

/** Hue in degrees, by the hexagonal construction. Only ever used as a weight. */
float rgbHue(vec3 c) {
    float maxc = max(c.r, max(c.g, c.b));
    float minc = min(c.r, min(c.g, c.b));
    float chroma = maxc - minc;
    if (chroma <= 0.0) return 0.0;
    float h;
    if (maxc == c.r)      h = mod((c.g - c.b) / chroma, 6.0);
    else if (maxc == c.g) h = (c.b - c.r) / chroma + 2.0;
    else                  h = (c.r - c.g) / chroma + 4.0;
    h *= 60.0;
    return h < 0.0 ? h + 360.0 : h;
}

/** Shortest signed distance between two hue angles, in degrees. */
float hueDistance(float a, float b) {
    float d = mod(a - b, 360.0);
    if (d > 180.0) d -= 360.0;
    if (d < -180.0) d += 360.0;
    return d;
}

/**
 * The weighted setting at a hue, given one adjustment per band.
 *
 * Six raised-cosine bands of half-width 60 degrees on 60-degree centres, which
 * is a partition of unity: the two neighbours of any hue sum to exactly one, so
 * a hue between bands receives their average rather than their sum.
 */
float bandedValue(float hue, float bands[6]) {
    float sum = 0.0;
    for (int i = 0; i < HSL_BAND_COUNT; i++) {
        float d = abs(hueDistance(hue, float(i) * HSL_BAND_SPACING));
        float w = d >= HSL_BAND_SPACING
            ? 0.0
            : 0.5 * (1.0 + cos(3.14159265358979 * d / HSL_BAND_SPACING));
        sum += w * bands[i];
    }
    return sum;
}

/**
 * Rotate about the neutral axis.
 *
 * Rodrigues about (1,1,1)/sqrt(3). At zero degrees cos is exactly 1 and sin
 * exactly 0, so every off-diagonal term is exactly zero and this is exactly the
 * identity — which is what makes the identity requirement structural.
 */
vec3 rotateHue(vec3 c, float degrees) {
    float a = radians(degrees);
    float co = cos(a);
    float si = sin(a);
    float t = (1.0 - co) / 3.0;
    float u = sqrt(1.0 / 3.0) * si;
    float m00 = co + t;
    float m01 = t - u;
    float m02 = t + u;
    return vec3(
        m00 * c.r + m01 * c.g + m02 * c.b,
        m02 * c.r + m00 * c.g + m01 * c.b,
        m01 * c.r + m02 * c.g + m00 * c.b
    );
}

#endif
