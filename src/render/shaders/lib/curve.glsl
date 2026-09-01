// Sampling a baked curve.
//
// The shader never evaluates a spline: the tangents depend on the whole control
// point set, so a fragment shader would need a variable-length loop per pixel.
// The curve is baked to a lookup texture on the CPU once per control point
// change and sampled here. docs/ARCHITECTURE.md section 6 states that as an
// architectural constraint rather than a note about one file.

// Map a value from the curve's own domain onto [0, 1].
//
// The lookup table spans the CONTROL POINT RANGE, not [0, 1]. For an ordinary
// tone curve those coincide and this is the identity; for a film characteristic
// curve over log exposure they do not, and code that assumes a unit domain works
// perfectly until the first curve that has another one.
float curveDomainToUnit(float x, vec2 domain) {
    return clamp((x - domain.x) / (domain.y - domain.x), 0.0, 1.0);
}

// Sample entry `unit * (size - 1)` of a size-N lookup texture.
//
// Texel centres are at (i + 0.5) / size, so the first and last samples sit at
// 0.5/size and (size - 0.5)/size rather than at 0 and 1. Sampling at `unit`
// directly is the classic lookup table bug: it shifts the whole curve by half a
// texel, which looks entirely plausible and shows up only as a small systematic
// offset. tests/render/curve.spec.ts introduces exactly that error and confirms
// the agreement test catches it.
float sampleCurveLut(sampler2D lut, float x, vec2 domain, float size) {
    float unit = curveDomainToUnit(x, domain);
    float u = (unit * (size - 1.0) + 0.5) / size;
    return texture(lut, vec2(u, 0.5)).r;
}
