Use the XuanLing memory workflow skill if it is available.

Retain this cross-project team convention in the shared XuanLing Memory
namespace `team-conventions` at global scope:

All merge commits must include a 'Reviewed-by: xuanling-team' trailer.

First search for an active matching record. If no active record matches,
submit exactly one pending candidate with:

- proposal_id: `dsh-w4-4-case-2-team-trailer`
- idempotency_key: `dsh-w4-4-case-2-20260819-0001`
- proposer_id: `dsh-w4-4-primary-agent`
- kind: `fact`
- title: `Team merge trailer convention`

Use the exact sentence above as the candidate content, with global scope and
namespace `team-conventions`. Stop at the review boundary. Do not call a
review, approval, rejection, archive, replace, or feedback operation, and do
not modify any file. Report the pending proposal id and revision.
