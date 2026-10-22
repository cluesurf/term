// Term data, from laws.tree. Keys are snake case, anchors are expanded.
const data = {
  "law": [
    {
      "name": "ownership",
      "rule": [
        "ownership",
        "ownership-of-replay"
      ]
    },
    {
      "name": "no-forged-permit",
      "hide": "permit"
    },
    {
      "name": "every-mutating-route-asks",
      "sole": "permit",
      "private": "bury-at"
    },
    {
      "name": "deleted-stays-gone",
      "rule": [
        "deleted-stays-gone",
        "deleted-stays-gone-of-view"
      ]
    },
    {
      "name": "isolation",
      "rule": [
        "isolation",
        "isolation-of-view"
      ]
    },
    {
      "name": "no-crash",
      "tier": 0
    },
    {
      "name": "safe-text",
      "rule": "safe-text"
    }
  ]
} as const

export default data
