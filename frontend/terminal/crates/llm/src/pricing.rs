//! Token → money conversion.
//!
//! Deliberately coarse: the company control plane needs a *number* hard enough
//! to stop runaway agents, not an invoice. Prices are USD per 1M tokens; the
//! authoritative catalogue lives in `hakus-config::pricing` and should replace
//! this table once the two crates are wired together.

use crate::Usage;

/// Price of one million tokens, in USD.
#[derive(Debug, Clone, Copy)]
pub struct Price {
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
}

impl Default for Price {
    fn default() -> Self {
        Self {
            input_per_mtok: 0.0,
            output_per_mtok: 0.0,
        }
    }
}

impl Price {
    /// Known models; unknown models fall back to the environment or zero.
    pub fn for_model(model: &str) -> Self {
        let m = model.to_ascii_lowercase();
        if m.contains("deepseek-reasoner") || m.contains("r1") {
            return Self {
                input_per_mtok: 0.55,
                output_per_mtok: 2.19,
            };
        }
        if m.contains("deepseek") {
            return Self {
                input_per_mtok: 0.27,
                output_per_mtok: 1.10,
            };
        }
        if m.contains("gpt-4o-mini") {
            return Self {
                input_per_mtok: 0.15,
                output_per_mtok: 0.60,
            };
        }
        if m.contains("gpt-4o") {
            return Self {
                input_per_mtok: 2.50,
                output_per_mtok: 10.00,
            };
        }
        if m.contains("haiku") {
            return Self {
                input_per_mtok: 0.80,
                output_per_mtok: 4.00,
            };
        }
        if m.contains("sonnet") {
            return Self {
                input_per_mtok: 3.00,
                output_per_mtok: 15.00,
            };
        }
        if m.contains("opus") {
            return Self {
                input_per_mtok: 15.00,
                output_per_mtok: 75.00,
            };
        }
        // Operator override wins for anything we don't recognise.
        Self::from_env().unwrap_or_default()
    }

    /// `HAKUS_PRICE_IN_PER_MTOK` / `HAKUS_PRICE_OUT_PER_MTOK`.
    pub fn from_env() -> Option<Self> {
        let in_p = std::env::var("HAKUS_PRICE_IN_PER_MTOK")
            .ok()?
            .parse::<f64>()
            .ok()?;
        let out_p = std::env::var("HAKUS_PRICE_OUT_PER_MTOK")
            .ok()?
            .parse::<f64>()
            .ok()?;
        Some(Self {
            input_per_mtok: in_p,
            output_per_mtok: out_p,
        })
    }

    /// Cost of a usage record, in cents.
    pub fn cost_cents(&self, usage: Usage) -> i64 {
        let usd = (usage.input_tokens as f64 / 1_000_000.0) * self.input_per_mtok
            + (usage.output_tokens as f64 / 1_000_000.0) * self.output_per_mtok;
        (usd * 100.0).round() as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deepseek_pricing_rounds_to_cents() {
        let p = Price::for_model("deepseek-chat");
        let usage = Usage {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
        };
        // 0.27 + 1.10 = 1.37 USD
        assert_eq!(p.cost_cents(usage), 137);
    }

    #[test]
    fn unknown_model_is_free_until_configured() {
        let p = Price::for_model("some-local-model");
        let usage = Usage {
            input_tokens: 10_000,
            output_tokens: 10_000,
        };
        assert_eq!(p.cost_cents(usage), 0);
    }
}
