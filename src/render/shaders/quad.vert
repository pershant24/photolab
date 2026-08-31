// The one vertex shader. Every pass is a fragment shader over a full-screen
// quad, so nothing here is pass-specific.
//
// The texture coordinate is derived from the clip-space position rather than
// supplied as a second attribute. `position * 0.5 + 0.5` is exact, and there is
// no pass that wants a UV which is not the position.

precision highp float;

layout(location = 0) in vec2 aPosition;

out vec2 vTexCoord;

void main() {
    vTexCoord = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
