use serde::{Deserialize, Serialize};
use std::fmt;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrorCode {
    NotFound,
    Unauthorized,
    InternalError,
    ResourceNotFound,
    NotImplementedForOS,
    NotImplemented,
    InvalidInput,
    ResourceAlreadyExists,
}

impl ErrorCode {
    pub fn get_code_as_u16(&self) -> u16 {
        match self {
            ErrorCode::Unauthorized => 401,
            ErrorCode::NotFound => 404,
            ErrorCode::ResourceNotFound => 405,
            ErrorCode::NotImplementedForOS => 406,
            ErrorCode::NotImplemented => 407,
            ErrorCode::InvalidInput => 408,
            ErrorCode::ResourceAlreadyExists => 409,
            ErrorCode::InternalError => 500,
        }
    }

    #[allow(dead_code)]
    pub fn from_code(code: u16) -> Option<ErrorCode> {
        match code {
            401 => Some(ErrorCode::Unauthorized),
            404 => Some(ErrorCode::NotFound),
            405 => Some(ErrorCode::ResourceNotFound),
            406 => Some(ErrorCode::NotImplementedForOS),
            407 => Some(ErrorCode::NotImplemented),
            408 => Some(ErrorCode::InvalidInput),
            409 => Some(ErrorCode::ResourceAlreadyExists),
            500 => Some(ErrorCode::InternalError),
            _ => None,
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ErrorCode::Unauthorized => write!(f, "Unauthorized"),
            ErrorCode::NotFound => write!(f, "NotFound"),
            ErrorCode::ResourceNotFound => write!(f, "ResourceNotFound"),
            ErrorCode::NotImplementedForOS => write!(f, "NotImplementedForOS"),
            ErrorCode::NotImplemented => write!(f, "NotImplemented"),
            ErrorCode::InvalidInput => write!(f, "InvalidInput"),
            ErrorCode::ResourceAlreadyExists => write!(f, "ResourceAlreadyExists"),
            ErrorCode::InternalError => write!(f, "InternalError"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Error)]
#[error("{custom_message}")]
pub struct Error {
    pub code: u16,
    pub message_from_code: ErrorCode,
    pub custom_message: String,
}

impl Error {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code: code.get_code_as_u16(),
            message_from_code: code,
            custom_message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn resource_not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ResourceNotFound, message)
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unauthorized, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InternalError, message)
    }

    pub fn already_exists(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ResourceAlreadyExists, message)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"code":500,"message_from_code":"InternalError","custom_message":"Failed to serialize error"}"#.to_string()
        })
    }
}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::NotFound => Error::resource_not_found(err.to_string()),
            std::io::ErrorKind::PermissionDenied => Error::unauthorized(err.to_string()),
            std::io::ErrorKind::AlreadyExists => Error::already_exists(err.to_string()),
            std::io::ErrorKind::InvalidInput => Error::invalid_input(err.to_string()),
            _ => Error::internal(err.to_string()),
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(err: serde_json::Error) -> Self {
        Error::internal(format!("JSON serialization error: {}", err))
    }
}

#[cfg(test)]
mod error_handling_tests {
    use crate::error_handling::{Error, ErrorCode};

    #[test]
    pub fn test() {
        let x = Error::new(ErrorCode::NotFound, "File not found".to_string());
        assert_eq!(x.code, 404);
        assert_eq!(x.to_string(), "File not found");
        assert!(x.to_json().contains("\"code\":404"));
    }
}
