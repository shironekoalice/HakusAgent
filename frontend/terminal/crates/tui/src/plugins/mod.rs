#![allow(dead_code)]

pub mod activation;
pub mod agent_plugin;
pub mod context;
pub mod discovery;
pub mod export;
pub mod extension_host;
pub mod install;
pub mod manifest;
pub mod marketplace;
pub mod mutation;
mod path_identity;
pub mod registry;
pub mod runtime;
pub mod types;

#[cfg(test)]
pub(crate) mod test_fixture;
#[cfg(test)]
mod tests;

pub use context::{HostEnvironment, PluginDiscoveryContext};
pub(crate) use path_identity::metadata_is_link_or_reparse;
pub use registry::PluginRegistry;
