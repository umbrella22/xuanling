//! XuanLing memory v2 contract tests (proposal/review lifecycle, C-03/C-04).

macro_rules! retrieval_behavior_test {
    ($item:item) => {
        $item
    };
}

#[path = "contract/memory_experimental_contract.rs"]
mod memory_experimental_contract;
#[path = "contract/memory_jsonl_contract.rs"]
mod memory_jsonl_contract;
#[path = "contract/memory_retrieval_contract.rs"]
mod memory_retrieval_contract;
#[path = "contract/memory_v2_contract.rs"]
mod memory_v2_contract;
