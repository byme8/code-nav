#import bump::lighting

struct Light {
    position: vec3<f32>,
    intensity: f32,
}

@group(0) @binding(0)
var<storage, read> lights: array<Light>;

const MAX_LIGHTS: u32 = 16u;

override shadow_bias: f32 = 0.005;

alias Color = vec4<f32>;

fn attenuate(light: Light, distance: f32) -> f32 {
    return light.intensity / (distance * distance);
}

@fragment
fn shade_pixel(@location(0) position: vec3<f32>) -> @location(0) vec4<f32> {
    var total = 0.0;
    for (var i = 0u; i < MAX_LIGHTS; i += 1u) {
        total += attenuate(lights[i], distance(lights[i].position, position));
    }
    return vec4<f32>(total);
}

#ifdef shadows
const SHADOW_SAMPLES: u32 = 4u;
#else
var<private> shadow_scale: f32 = 1.0;
#endif

fn shadow_factor() -> f32 {
#ifdef shadows
    return 0.5;
#else
    return 1.0;
#endif
}

fn ambient() -> f32 {
    return 0.1;
}
