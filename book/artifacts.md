# Artifacts in StarTree

This is how you would define them.

```
# resource in terraform
seed google-storage-bucket
  bind name, <foo>
  bind location, text <US>
  bind uniform-bucket-level-access, term true

# data in terraform
need app-ami, like aws-ami
  bind most-recent, term true

seed app, like aws-instance
  bind ami, "${data.aws_ami.app_ami.id}"
  bind instance-type, <t2.micro>

seed default, like google-cloudfunctions2-function
  bind name, <function-v2>
  bind location, <us-central1>
  bind description, <a new function>

  bind build-config
    bind runtime, <nodejs16>
    bind entry-point, <helloHttp> # Set the entry point
    bind source
      bind storage-source
        bind bucket, loan google-storage-bucket.default.name
        bind object, loan google-storage-bucket-object.object.name

save project-id, <123>

tool google
  bind project, loan project-id
  bind region, loan region
```

This is how the values would be saved in a sort of `seed.tree` file.

```
mark <1.2.3>

seed example, like aws-instance
  sort managed
  bind ami, <ami-0fb653ca2d3203ac1>
  bind availability-zone, <us-east-2b>
```

The provided code showcases the definition of artifacts, which are
similar to resources in Terraform, in StarTree. Let's explore the
different elements and syntax used:

1. **Resource Definition:** The artifacts are defined using the `seed`
   keyword, similar to resources in Terraform. Each artifact has a
   unique name, such as `google-storage-bucket`, `app-ami`, `app`, or
   `default`.

2. **Bindings:** Bindings are used to associate values with specific
   properties of the artifact. Bindings can be either a direct value or
   a reference to other artifacts or data sources.

3. **Data Sources:** Data sources are defined using the `need` keyword,
   similar to retrieving data in Terraform. The data source, such as
   `app-ami`, fetches information like the most recent AWS AMI.

4. **Nested Bindings:** Bindings can be nested to define complex
   structures, such as the `build-config` under the `default` artifact.

5. **Saving Values:** Values can be saved using the `save` keyword, such
   as `project-id`, to store specific data for later use.

6. **Tool Configuration:** Tool configurations can be defined, such as
   the `google` tool, with bindings to retrieve and use the saved
   values, like `project-id` and `region`.

### Saving the Values

The values can be saved in a separate `seed.tree` file, following a
similar syntax to the artifact definitions. The `base` statement at the
beginning sets the version or base for the `seed.tree` file.

### Remote Storage with the Moon Framework

To save the artifacts remotely using a cloud provider, the
`base bind site` statement is used, indicating that the artifacts should
be saved in a remote site using the Moon framework.

This syntax in StarTree allows you to define and configure artifacts
with their properties, bindings, and dependencies. It provides a
structured way to manage and orchestrate resources or artifacts in your
infrastructure or cloud environment.
