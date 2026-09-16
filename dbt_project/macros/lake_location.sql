{#-
  Where a materialized model is allowed to land.

  Only the `prod` target may write into the S3 lake. Every other target (dev, an
  unnamed one, a typo) writes under LAKE_DEV_ROOT instead, so iterating on a
  model on a laptop cannot publish to production gold. Fail-safe by default: the
  S3 branch is opt-in by name, not the fallback.

  Usage in a model config:

      {{ config(materialized='external', location=lake_location('gold', 'bess_asset_daily')) }}

  `name` with no extension means a partitioned directory (pair it with
  options={'partition_by': ...}); `name.parquet` means a single object.
-#}
{% macro lake_location(layer, name) -%}
  {%- if target.name == 'prod' -%}
    s3://{{ env_var('LAKE_BUCKET', 'nuravolt-lake') }}/{{ layer }}/{{ name }}
  {%- else -%}
    {{ env_var('LAKE_DEV_ROOT', 'dev_lake') }}/{{ layer }}/{{ name }}
  {%- endif -%}
{%- endmacro %}
