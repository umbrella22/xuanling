# 文件安全 RFC 0002 Stage 2 current-policy 证据报告

> 证据状态：Stage 2 `Accepted`；Stage 3 `Not Triggered / Deferred`；不改变生产默认。
> 原始证据根：`/private/tmp/xuanling-dsh-fs-eval.codex-fs-stage2-20260816-1317`。
> 验证器：`test/deepseek-harness/evaluation/scripts/verify-stage2-report.mjs`。

## 范围

评估绑定 XuanLing revision `48182b1b316f22831235cb75129a2fb430b9b39e` 与 DeepSeek Harness
revision `47f943859bef60e4160492346772ded9b24f765a`。三臂共享冻结 fixture、prompt、
`deepseek-official/deepseek-v4-pro/max` 路由和旁路禁用集合。每臂包含三次 quality trial 与一组
cold/warm cache pair，共 15 个隔离 session、workspace、DSH_HOME 和 Memory DB。

Arm A 只暴露 DSH Native 文件工具；Arm B 只暴露 XuanLing fs16；Arm C 同时暴露两族文件工具。
B/C 安装的 bundle 与 strict overwrite policy 均由 trial metadata 固定 hash。credential 使用
owner-only 外部文件引用；runner 未读取、复制、hash 或输出其正文。

## 验收结果

runner 完整采集 15/15，runner oracle 通过 15/15。analyzer v8 确认 15/15 session 具有 canonical
`turn/end`、唯一 call/result 关系、完整 provider usage、固定 route 和可归属工具调用。独立文件
oracle 从保留的 workspace 或 workspace snapshot 重判 15/15 通过。

| Arm | 完整/Oracle/Route/Usage | Native fs calls | XuanLing fs calls | 模型可见 result bytes | 平均时长（ms） |
| --- | --- | ---: | ---: | ---: | ---: |
| A | 5/5 / 5/5 / 5/5 / 5/5 | 75 | 0 | 48,898 | 49,613.2 |
| B | 5/5 / 5/5 / 5/5 / 5/5 | 0 | 85 | 67,399 | 76,304.8 |
| C | 5/5 / 5/5 / 5/5 / 5/5 | 70 | 6 | 52,435 | 62,446.2 |

B 在没有 Native fallback 的条件下完成全部任务，证明当前 fs16 目录能够独立完成这一个冻结
工作负载。C 的 76 次文件调用中只有 6 次使用 XuanLing；当前样本没有显示同时暴露两族工具会
稳定选用 XuanLing 的独有原语。

全部结果中只有一个 typed error：C quality trial 3 在创建 `RELEASE.md` 前调用
`mcp__xuanling__fs_stat` 确认文件不存在，返回 `not_found`。该错误没有同名重试，最终 workspace
仍通过 oracle。15 个 live session 没有触发 strict overwrite policy 拒绝；policy 的 pre-dispatch
行为由 Stage 1 三连 direct/Code Mode probe 证明，current population 只证明其 bundle/hash 已进入
每个适用 profile。

## Usage 与 Cache

| Arm | 平均 inputTokens | 平均 outputTokens | 平均 cacheReadTokens | 平均时长（ms） |
| --- | ---: | ---: | ---: | ---: |
| A | 7,390.4 | 4,649.4 | 69,094.4 | 49,613.2 |
| B | 11,350.2 | 7,124.6 | 131,020.8 | 76,304.8 |
| C | 11,896.2 | 5,869.6 | 109,670.4 | 62,446.2 |

全部 15 个 session 的 `cache_read_share` 为 `0.91`。每臂 cold/warm pair 的模型可见首请求前缀
SHA-256 相同，warm `inputTokens` 均低于 cold：A 为 8,613 到 3,163，B 为 13,506 到
4,985，C 为 13,790 到 3,547。每臂只有一个 pair，因此这些数字只证明本次前缀稳定和 usage
观测，不能推导长期命中率或价格因果关系。

本任务中 B 相比 A 使用更多 input/output/cache token、结果正文和时间。该差异支持继续保留
DSH Native 文件工具作为当前默认文件体验，并把 XuanLing fs16 保留为需要 CAS、strict patch、
完整分页或显式 byte budget 时的 opt-in 工具面。本报告不应用 bundle 变更，也不把单任务结果
外推为通用工具排名。

## 历史基线

历史报告 `filesystem-tools-report.md` 绑定 pre-policy evidence root，analyzer schema 为 v7。它不
参与 current-policy 验收。两轮都完成 15/15 oracle，但模型采样与运行时段不同；下表只记录观测
变化，不形成 policy 或 analyzer 导致变化的因果判断。

| Arm | 历史文件调用 | 当前文件调用 | 历史平均时长（ms） | 当前平均时长（ms） |
| --- | ---: | ---: | ---: | ---: |
| A | Native 84 / XuanLing 0 | Native 75 / XuanLing 0 | 73,265.6 | 49,613.2 |
| B | Native 0 / XuanLing 101 | Native 0 / XuanLing 85 | 148,290.6 | 76,304.8 |
| C | Native 76 / XuanLing 1 | Native 70 / XuanLing 6 | 64,805.8 | 62,446.2 |

## Stage 3 触发决策

| Trigger | 结论 | 当前证据 |
| --- | --- | --- |
| 两个以上 host 需要同一 strict overwrite policy | `not_triggered` | 当前 checkout 只有 `integrations/deepseek-harness` 声明并加载该 policy，没有第二个 host 合同。 |
| DSH policy 存在 direct/Code Mode dispatch bypass | `not_triggered` | Stage 1 三连 probe 为 16/16；current catalog inspect 为 24/24，全部模型可见旁路行禁用。 |
| fs16 形成稳定、可量化的正确性缺口 | `not_triggered` | B quality oracle 3/3，B 五个 session 全部 complete，filesystem contract error 为 0；未达到两个同因失败的触发门槛。 |

三个条件均未触发，Stage 3 状态为 `Not Triggered / Deferred`。Rust DTO、MCP catalog、snapshot、
默认行为和生产 bundle 均不变化。

## 限制

- 每臂只有三次 quality trial、一个 cache pair 和一个冻结任务；没有统计显著性。
- 文件 oracle 证明最终 tree，不证明任意工程、所有错误恢复或所有审批路径。
- live population 没有触发 unsafe overwrite；该失败路径依赖 Stage 1 deterministic probe。
- file-reference 模式无法执行 exact credential-value scan；结构隔离、credential-shaped scan、
  `secret_redactions=0` 和 DSH_HOME 文件清单共同构成当前安全证据。
- `model_visible_bytes` 来自 canonical tool-result content，不是 JSONL 文件大小或 provider 定价。

## 机器可复算证据

```json
{
  "schema": "xuanling-dsh-filesystem-safety-stage2-report/v2",
  "evidence_root": "/private/tmp/xuanling-dsh-fs-eval.codex-fs-stage2-20260816-1317",
  "population": {
    "arms": [
      "A",
      "B",
      "C"
    ],
    "quality_runs": 3,
    "cache_pairs": 1
  },
  "analyzer_version": 8,
  "frozen_route": {
    "model": "deepseek-v4-pro",
    "provider": "deepseek-official",
    "reasoning_effort": "max"
  },
  "credential_source": "file_reference",
  "fixture": {
    "task_sha256": "faff54eae2b9863225f9bd424db8d0ffa3178dcb657e3fd4eef3ce7276298000"
  },
  "policy": {
    "evaluation_schema": "xuanling-dsh-filesystem-safety-stage2/v2",
    "skills_bundle_sha256": "57eb2adb325e4b581a03909c34c87ea6fde0db416fcea10dd2729ebf2037fc62",
    "strict_overwrite_policy_sha256": "84c562fce86c209c35d7d8a29cdd8febcd226dabf95d7e2d09d3fae605a10800",
    "common_patch_sha256": "604c6a03c7aea776ea9f0b2b71a714314a892d7046f894d2e1d4d0abda6fa3fe",
    "arm_patch_sha256": {
      "A": "220d0ae47e7413443cc1da58bf41293e1025572ecb59fe22e9d27de51247b17e",
      "B": "dd8906e9a4db0b801dd83031413a7c7969e2813f5e9d388698f54973bceb95fe",
      "C": "d8019154d1863ad9623c9f55769aeb56ae1edfae6cc73943a49b5cc9922303d5"
    }
  },
  "coverage": {
    "total_trials": 15,
    "oracle_passed": 15,
    "route_valid": 15,
    "usage_known": 15,
    "cache_read_share": 0.91,
    "secret_redactions": 0,
    "tool_results": {
      "count": 274,
      "model_visible_bytes": 168732,
      "error_count": 1,
      "retry_after_error_count": 0,
      "error_codes": {
        "not_found": 1
      },
      "by_family": {
        "skill": {
          "count": 15,
          "model_visible_bytes": 66027,
          "error_count": 0,
          "retry_after_error_count": 0
        },
        "native_fs": {
          "count": 145,
          "model_visible_bytes": 53356,
          "error_count": 0,
          "retry_after_error_count": 0
        },
        "control": {
          "count": 23,
          "model_visible_bytes": 1932,
          "error_count": 0,
          "retry_after_error_count": 0
        },
        "xuanling_fs": {
          "count": 91,
          "model_visible_bytes": 47417,
          "error_count": 1,
          "retry_after_error_count": 0
        }
      }
    }
  },
  "arms": {
    "A": {
      "total_trials": 5,
      "quality_trials": 3,
      "quality_oracle_passed": 3,
      "complete": 5,
      "oracle_passed": 5,
      "route_valid": 5,
      "usage_known": 5,
      "duration_ms": {
        "total": 248066,
        "average": 49613.2
      },
      "usage": {
        "inputTokens": 36952,
        "outputTokens": 23247,
        "cacheReadTokens": 345472,
        "cacheWriteTokens": 0
      },
      "tool_calls": {
        "xuanling_fs": 0,
        "native_fs": 75,
        "skill": 5,
        "control": 6,
        "shell": 0
      },
      "tool_results": {
        "count": 86,
        "model_visible_bytes": 48898,
        "error_count": 0,
        "retry_after_error_count": 0,
        "error_codes": {},
        "by_family": {
          "skill": {
            "count": 5,
            "model_visible_bytes": 22009,
            "error_count": 0,
            "retry_after_error_count": 0
          },
          "native_fs": {
            "count": 75,
            "model_visible_bytes": 26385,
            "error_count": 0,
            "retry_after_error_count": 0
          },
          "control": {
            "count": 6,
            "model_visible_bytes": 504,
            "error_count": 0,
            "retry_after_error_count": 0
          }
        }
      }
    },
    "B": {
      "total_trials": 5,
      "quality_trials": 3,
      "quality_oracle_passed": 3,
      "complete": 5,
      "oracle_passed": 5,
      "route_valid": 5,
      "usage_known": 5,
      "duration_ms": {
        "total": 381524,
        "average": 76304.8
      },
      "usage": {
        "inputTokens": 56751,
        "outputTokens": 35623,
        "cacheReadTokens": 655104,
        "cacheWriteTokens": 0
      },
      "tool_calls": {
        "xuanling_fs": 85,
        "native_fs": 0,
        "skill": 5,
        "control": 9,
        "shell": 0
      },
      "tool_results": {
        "count": 99,
        "model_visible_bytes": 67399,
        "error_count": 0,
        "retry_after_error_count": 0,
        "error_codes": {},
        "by_family": {
          "skill": {
            "count": 5,
            "model_visible_bytes": 22009,
            "error_count": 0,
            "retry_after_error_count": 0
          },
          "xuanling_fs": {
            "count": 85,
            "model_visible_bytes": 44634,
            "error_count": 0,
            "retry_after_error_count": 0
          },
          "control": {
            "count": 9,
            "model_visible_bytes": 756,
            "error_count": 0,
            "retry_after_error_count": 0
          }
        }
      }
    },
    "C": {
      "total_trials": 5,
      "quality_trials": 3,
      "quality_oracle_passed": 3,
      "complete": 5,
      "oracle_passed": 5,
      "route_valid": 5,
      "usage_known": 5,
      "duration_ms": {
        "total": 312231,
        "average": 62446.2
      },
      "usage": {
        "inputTokens": 59481,
        "outputTokens": 29348,
        "cacheReadTokens": 548352,
        "cacheWriteTokens": 0
      },
      "tool_calls": {
        "xuanling_fs": 6,
        "native_fs": 70,
        "skill": 5,
        "control": 8,
        "shell": 0
      },
      "tool_results": {
        "count": 89,
        "model_visible_bytes": 52435,
        "error_count": 1,
        "retry_after_error_count": 0,
        "error_codes": {
          "not_found": 1
        },
        "by_family": {
          "skill": {
            "count": 5,
            "model_visible_bytes": 22009,
            "error_count": 0,
            "retry_after_error_count": 0
          },
          "native_fs": {
            "count": 70,
            "model_visible_bytes": 26971,
            "error_count": 0,
            "retry_after_error_count": 0
          },
          "control": {
            "count": 8,
            "model_visible_bytes": 672,
            "error_count": 0,
            "retry_after_error_count": 0
          },
          "xuanling_fs": {
            "count": 6,
            "model_visible_bytes": 2783,
            "error_count": 1,
            "retry_after_error_count": 0
          }
        }
      }
    }
  },
  "cache_pairs": [
    {
      "arm": "A",
      "request_prefix_sha256": "286831151ce2acfbb922eb07423f9d25e6d3258be7e67820ce4beb174f2ee6fd",
      "cold_usage": {
        "inputTokens": 8613,
        "outputTokens": 3873,
        "cacheReadTokens": 62592,
        "cacheWriteTokens": 0
      },
      "warm_usage": {
        "inputTokens": 3163,
        "outputTokens": 4585,
        "cacheReadTokens": 71936,
        "cacheWriteTokens": 0
      }
    },
    {
      "arm": "B",
      "request_prefix_sha256": "75de6d3bbeee52296bff4ca65da1e8787a7e45b161b75c88dba6bfa163f7cd33",
      "cold_usage": {
        "inputTokens": 13506,
        "outputTokens": 5429,
        "cacheReadTokens": 182144,
        "cacheWriteTokens": 0
      },
      "warm_usage": {
        "inputTokens": 4985,
        "outputTokens": 6033,
        "cacheReadTokens": 153088,
        "cacheWriteTokens": 0
      }
    },
    {
      "arm": "C",
      "request_prefix_sha256": "71c03f280677aa0741855107af31ec4b83b9910fe034f9a83133d986bd760055",
      "cold_usage": {
        "inputTokens": 13790,
        "outputTokens": 6269,
        "cacheReadTokens": 112896,
        "cacheWriteTokens": 0
      },
      "warm_usage": {
        "inputTokens": 3547,
        "outputTokens": 5352,
        "cacheReadTokens": 118912,
        "cacheWriteTokens": 0
      }
    }
  ],
  "stage3": {
    "status": "not_triggered_deferred",
    "triggers": {
      "multi_host_strict_policy": {
        "status": "not_triggered",
        "evidence": "Current checkout repository scan: the strict overwrite policy is required only by integrations/deepseek-harness; no second host contract is present."
      },
      "dispatch_bypass": {
        "status": "not_triggered",
        "evidence": "Stage 1 direct and Code Mode probe passed 16/16 for three consecutive runs, and the current A/B/C catalog inspection passed 24/24 with all model-facing bypass rows disabled."
      },
      "fs16_contract_gap": {
        "status": "not_triggered",
        "evidence": "Current Arm B quality oracle passed 3/3, all five B sessions completed, and B recorded zero filesystem contract errors; the two-failure trigger threshold is not met."
      }
    }
  },
  "decision": {
    "stage2_status": "accepted",
    "stage3_status": "not_triggered_deferred",
    "production_change": false
  }
}
```
