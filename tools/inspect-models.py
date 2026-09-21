#!/usr/bin/env python3
"""Print ONNX graph metadata and I/O signatures for the pinned models (audit helper).

Usage: python tools/inspect-models.py models/*.onnx     (requires `pip install onnx`)
"""
import sys
import onnx


def sig(v):
    t = v.type.tensor_type
    dims = [d.dim_value if d.dim_value else d.dim_param for d in t.shape.dim]
    return f"{v.name}: {onnx.TensorProto.DataType.Name(t.elem_type).lower()}{dims}"


for path in sys.argv[1:]:
    m = onnx.load(path, load_external_data=False)
    ext = [t.name for t in m.graph.initializer if t.data_location == onnx.TensorProto.EXTERNAL]
    print(f"== {path}")
    print(f"   ir_version={m.ir_version} opsets={[(o.domain or 'ai.onnx', o.version) for o in m.opset_import]} producer={m.producer_name} {m.producer_version}")
    print("   inputs :", "; ".join(sig(i) for i in m.graph.input))
    print("   outputs:", "; ".join(sig(o) for o in m.graph.output))
    print(f"   external_data_initializers={len(ext)}")
    ops = {}
    for n in m.graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
    print("   ops:", ", ".join(f"{k}×{v}" for k, v in sorted(ops.items())))
