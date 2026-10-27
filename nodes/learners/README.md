# Learners

The `ml mapper` node (`pihub-ml`) does the bookkeeping: it watches device parameters, records
input→output pairs, saves/loads FluCoMa `fluid.dataset` files, and emits predictions. The actual
algorithm is a **learner module** in this folder. Swap the ML by writing one file.

A learner module exports:

```js
module.exports = {
  name: 'my-learner',
  modelFile: true,                       // false if the recorded dataset *is* the model (e.g. knn)
  create(cfg) { ... return instance },   // cfg: { nIn, nOut, hidden[], activation, epochs, lr, k }
  fromJSON(json, cfg) { ... return instance },   // throws if json does not fit cfg
};
// instance:
//   fit(X, Y)      -> string describing the result (loss, time, ...)
//   predict(x)     -> array of nOut numbers
//   toJSON()       -> object to write to model.json (only if modelFile)
```

`X`/`Y` are arrays of arrays of numbers in 0..1. Register the module in `pihub-ml.js` (`LEARNERS`) and it
appears in the node's Learner dropdown.

Shipped:
- `fluid-mlp.js` — multilayer perceptron, reads and writes `fluid.mlpregressor` JSON (same activation codes,
  same layer layout), so models move between the hub and Max / Data Knot.
- `knn.js` — k-nearest-neighbour regressor, distance-weighted. No model file; the datasets are the model.
