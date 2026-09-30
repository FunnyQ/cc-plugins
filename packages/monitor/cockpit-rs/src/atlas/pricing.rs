// Stub until its port lands; the port removes this allow.
#![allow(dead_code, unused_variables)]

use super::model::{Ctx, ModelUsage};
use serde::Serialize;

#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {}

#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingTable {}

#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingMeta {}

pub struct PricingLoad {
    pub table: PricingTable,
    pub meta: PricingMeta,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingRefreshResult {}

pub async fn load_pricing_with_meta(ctx: &Ctx) -> anyhow::Result<PricingLoad> {
    todo!()
}

pub fn clear_pricing_cache() {
    todo!()
}

pub fn price_for(model: &str, table: &PricingTable) -> ModelPrice {
    todo!()
}

pub fn calc_cost(usage: &ModelUsage, model: &str, table: &PricingTable) -> f64 {
    todo!()
}

pub fn normalize_model_id(id: &str) -> String {
    todo!()
}

pub fn pricing_model_aliases(model: &str, table: &PricingTable) -> Vec<String> {
    todo!()
}

pub fn pricing_meta_for_models(pricing: &PricingLoad, models: &[String]) -> serde_json::Value {
    todo!()
}

pub async fn refresh_pricing_override(
    ctx: &Ctx,
    models: Vec<String>,
) -> anyhow::Result<PricingRefreshResult> {
    todo!()
}

/// The full `--source pricing` shape (loadPricingWithMeta's value).
pub fn source_json(load: &PricingLoad) -> serde_json::Value {
    todo!()
}
