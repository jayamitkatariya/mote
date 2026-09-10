use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

const WINDOW: Duration = Duration::from_millis(700);
const COOLDOWN: Duration = Duration::from_millis(1000);
const SAMPLE_INTERVAL: Duration = Duration::from_millis(8);

static ENABLED: AtomicBool = AtomicBool::new(true);
static POINTER_DOWN: AtomicBool = AtomicBool::new(false);
static SENSITIVITY: AtomicU8 = AtomicU8::new(3);

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn set_pointer_down(down: bool) {
    POINTER_DOWN.store(down, Ordering::Relaxed);
}

pub fn set_sensitivity(value: u8) {
    SENSITIVITY.store(value.clamp(1, 5), Ordering::Relaxed);
}

pub fn min_step(sensitivity: u8) -> f64 {
    40.0 - (sensitivity.clamp(1, 5) as f64) * 6.0
}

pub fn cursor_position() -> Option<(f64, f64)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
    let event = CGEvent::new(source).ok()?;
    let point = event.location();
    Some((point.x, point.y))
}

pub struct ShakeDetector {
    samples: VecDeque<(Instant, f64)>,
    last_sample: Option<Instant>,
    last_fire: Option<Instant>,
}

impl Default for ShakeDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl ShakeDetector {
    pub fn new() -> Self {
        Self {
            samples: VecDeque::new(),
            last_sample: None,
            last_fire: None,
        }
    }

    pub fn push(&mut self, now: Instant, x: f64, min_step: f64) -> bool {
        if let Some(last) = self.last_sample {
            if now.duration_since(last) < SAMPLE_INTERVAL {
                return false;
            }
        }
        self.last_sample = Some(now);

        self.samples.push_back((now, x));
        while let Some((time, _)) = self.samples.front() {
            if now.duration_since(*time) > WINDOW {
                self.samples.pop_front();
            } else {
                break;
            }
        }

        if self.samples.len() < 6 {
            return false;
        }

        let mut direction = 0.0_f64;
        let mut extreme = self.samples.front().map(|(_, value)| *value).unwrap_or(x);
        let mut turns = 0_u32;
        let mut minimum = extreme;
        let mut maximum = extreme;

        for (_, value) in self.samples.iter() {
            minimum = minimum.min(*value);
            maximum = maximum.max(*value);
            let delta = value - extreme;
            if direction == 0.0 {
                if delta.abs() > 1.0 {
                    direction = delta.signum();
                    extreme = *value;
                }
            } else if delta.signum() == direction {
                extreme = *value;
            } else if delta.abs() >= min_step {
                turns += 1;
                direction = -direction;
                extreme = *value;
            }
        }

        if turns < 4 || (maximum - minimum) < min_step * 2.0 {
            return false;
        }

        if let Some(last) = self.last_fire {
            if now.duration_since(last) < COOLDOWN {
                return false;
            }
        }

        self.last_fire = Some(now);
        true
    }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut detector = ShakeDetector::new();
        loop {
            std::thread::sleep(SAMPLE_INTERVAL);
            if !ENABLED.load(Ordering::Relaxed) || POINTER_DOWN.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(80));
                continue;
            }
            let Some((x, _)) = cursor_position() else {
                continue;
            };
            let now = Instant::now();
            if detector.push(now, x, min_step(SENSITIVITY.load(Ordering::Relaxed))) {
                let _ = app.emit("mote://shake", ());
                crate::toggle(&app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(positions: &[f64], step_ms: u64, min_step: f64) -> bool {
        let start = Instant::now();
        let mut detector = ShakeDetector::new();
        let mut fired = false;
        for (index, x) in positions.iter().enumerate() {
            let now = start + Duration::from_millis(step_ms * index as u64);
            if detector.push(now, *x, min_step) {
                fired = true;
            }
        }
        fired
    }

    #[test]
    fn detects_vigorous_shake() {
        let sequence: Vec<f64> = (0..40)
            .map(|index| if index % 4 < 2 { 0.0 } else { 140.0 })
            .collect();
        assert!(run(&sequence, 16, 22.0));
    }

    #[test]
    fn ignores_slow_drift() {
        let sequence: Vec<f64> = (0..60).map(|index| index as f64 * 3.0).collect();
        assert!(!run(&sequence, 16, 22.0));
    }

    #[test]
    fn ignores_tiny_jitter() {
        let sequence: Vec<f64> = (0..60)
            .map(|index| if index % 2 == 0 { 0.0 } else { 4.0 })
            .collect();
        assert!(!run(&sequence, 16, 22.0));
    }

    #[test]
    fn ignores_wide_slow_sway() {
        let sequence: Vec<f64> = (0..80)
            .map(|index| if index % 30 < 15 { 0.0 } else { 200.0 })
            .collect();
        assert!(!run(&sequence, 16, 22.0));
    }

    #[test]
    fn respects_cooldown() {
        let sequence: Vec<f64> = (0..120)
            .map(|index| if index % 4 < 2 { 0.0 } else { 140.0 })
            .collect();
        let start = Instant::now();
        let mut detector = ShakeDetector::new();
        let mut fire_times = Vec::new();
        for (index, x) in sequence.iter().enumerate() {
            let time = start + Duration::from_millis(16 * index as u64);
            if detector.push(time, *x, 22.0) {
                fire_times.push(16 * index as u64);
            }
        }
        assert!(fire_times.len() >= 2);
        for pair in fire_times.windows(2) {
            assert!(pair[1] - pair[0] >= 1000);
        }
    }
}
