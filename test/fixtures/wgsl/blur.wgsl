fn blur_row(samples: array<f32, 4>) -> f32 {
    return (samples[0] + samples[1] + samples[2] + samples[3]) * 0.25;
}
