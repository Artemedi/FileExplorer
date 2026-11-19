use crate::models::ranking_config::RankingConfig;
use serde::{Deserialize, Serialize};
use std::time::Duration;

fn default_fuzzy_search_enabled() -> bool {
    true
}

/// Configuration options for the search engine.
///
/// Defines adjustable parameters that control search engine behavior,
/// including result limits, file type preferences, and indexing constraints.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct SearchEngineConfig {
    pub search_engine_enabled: bool,
    pub max_results: usize,
    pub preferred_extensions: Vec<String>,
    pub excluded_patterns: Option<Vec<String>>,
    pub cache_size: usize,
    pub ranking_config: RankingConfig,
    pub prefer_directories: bool,
    pub cache_ttl: Option<Duration>,
    #[serde(default)]
    pub index_hidden_files: bool,
    #[serde(default = "default_fuzzy_search_enabled")]
    pub fuzzy_search_enabled: bool,
    #[serde(default)]
    pub case_sensitive_search: bool,
    // To be implemented
    //pub collect_usage_stats: bool,
    //pub indexing_logging_enabled: bool,
    //pub search_logging_enabled: bool,
    //pub search_timeout_ms: Option<u64>,
    //pub result_score_threshold: Option<f32>,
    //pub min_query_length: Option<usize>,
    //pub max_indexed_files: Option<usize>,
    //pub max_index_depth: Option<usize>,
    //pub follow_symlinks: bool,
    //pub fuzzy_trigram_threshold: Option<f32>,
    //pub group_results_by_directory: bool,
    //pub persistent_index_path: Option<String>,
    //pub index_compression_enabled: bool,
    //pub indexing_priority: Option<u8>,
    //pub default_search_operator: Option<String>,
    //pub enable_wildcard_search: bool,
    ////pub indexing_batch_size: Option<usize>,
    //pub retry_failed_indexing: bool,
}

impl Default for SearchEngineConfig {
    fn default() -> Self {
        Self {
            search_engine_enabled: true,
            max_results: 100,
            ranking_config: RankingConfig::default(),
            preferred_extensions: vec![
                "txt".to_string(),
                "pdf".to_string(),
                "docx".to_string(),
                "xlsx".to_string(),
                "md".to_string(),
                "rs".to_string(),
                "js".to_string(),
                "html".to_string(),
                "css".to_string(),
                "json".to_string(),
                "png".to_string(),
                "jpg".to_string(),
            ],
            excluded_patterns: Some(vec![
                ".git".to_string(),
                "node_modules".to_string(),
                "target".to_string(),
                "AppData".to_string(),
                ".cache".to_string(),
                ".npm".to_string(),
                ".cargo".to_string(),
                ".rustup".to_string(),
                ".vscode".to_string(),
                "$Recycle.Bin".to_string(),
                "System Volume Information".to_string(),
                "Temp".to_string(),
            ]),
            cache_size: 1000,
            cache_ttl: Some(Duration::from_secs(300)), // 5 minutes
            prefer_directories: false,
            index_hidden_files: false,
            fuzzy_search_enabled: true,
            case_sensitive_search: false,
            //collect_usage_stats: true,
            //indexing_logging_enabled: false,
            //search_logging_enabled: false,
            //search_timeout_ms: Some(5000), // 5 seconds
            //result_score_threshold: Some(0.1),
            //min_query_length: None,
            //max_indexed_files: None,
            //max_index_depth: None,
            //follow_symlinks: false,
            //fuzzy_trigram_threshold: Some(0.5),
            //group_results_by_directory: true,
            //persistent_index_path: None,
            //index_compression_enabled: true,
            //indexing_priority: Some(1),
            //default_search_operator: Some("AND".to_string()),
            //enable_wildcard_search: false,
            //indexing_batch_size: Some(100),
            //retry_failed_indexing: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_search_engine_config_defaults() {
        let config = SearchEngineConfig::default();
        assert!(!config.index_hidden_files);
        assert!(config.fuzzy_search_enabled);
        assert!(!config.case_sensitive_search);
    }

    #[test]
    fn test_search_engine_config_deserializes_legacy_json_without_new_flags() {
        let legacy_json = json!({
            "search_engine_enabled": true,
            "max_results": 50,
            "preferred_extensions": ["txt"],
            "excluded_patterns": [".git"],
            "cache_size": 500,
            "ranking_config": RankingConfig::default(),
            "prefer_directories": true,
            "cache_ttl": { "secs": 60, "nanos": 0 }
        });

        let config: SearchEngineConfig = serde_json::from_value(legacy_json)
            .expect("Legacy SearchEngineConfig should deserialize");
        assert!(config.search_engine_enabled);
        assert_eq!(config.max_results, 50);
        assert!(config.prefer_directories);
        assert!(!config.index_hidden_files);
        assert!(config.fuzzy_search_enabled);
        assert!(!config.case_sensitive_search);
    }
}
