//! Toolkit contract test suite (plan §10 W0).
//!
//! Each file under `contract/` covers one boundary. The W0 red tests assert
//! the absence of forbidden behaviors (hidden truncation, root containment,
//! shell parsing, server timeout, non-snake-case error codes). They are
//! expected to FAIL until the relevant wave implements the behavior; the
//! failure must point at the missing behavior, not a build/fixture error.

#[path = "contract/capability_contract.rs"]
mod capability_contract;
#[path = "contract/coexistence.rs"]
mod coexistence;
#[path = "contract/dependency.rs"]
mod dependency;
#[path = "contract/error_contract.rs"]
mod error_contract;
#[path = "contract/fs_contract.rs"]
mod fs_contract;
#[path = "contract/fs_w2_contract.rs"]
mod fs_w2_contract;
#[path = "contract/path_contract.rs"]
mod path_contract;
#[path = "contract/path_resolve_contract.rs"]
mod path_resolve_contract;
#[path = "contract/process_contract.rs"]
mod process_contract;
#[path = "contract/process_run_contract.rs"]
mod process_run_contract;
#[path = "contract/project_contract.rs"]
mod project_contract;
#[path = "contract/system_contract.rs"]
mod system_contract;
