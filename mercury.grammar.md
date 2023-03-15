syntax grammar
```
mercury:
    (term end) *

```

semantic grammar
```
mercury:
    module_decl
    interface_decl
    export_decl*
    implementation_decl
    implementation_program*
    end_module_decl?

export_decl:
    import_module_decl
    |use_module_decl
    |include_module_decl
    |pred_decl
    |mode_decl
    |func_decl
    |type_decl
    |inst_decl

implementation_program：
    type_decl
    |slover_type_decl
    |pred_decl
    |func_decl
    |inst_decl
    |mode_decl
    |typesclass_decl
    |instance_decl
    |pragma_decl
    |promise_decl
    |initialise_decl
    |finalise_decl
    |mutable_decl
    |import_module_decl
    |use_module_decl
    |include_module_decl
    |function_fact
    |pred_fact
    |function_rule
    |pred_rule
    |user_type_defn

```