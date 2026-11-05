---
title: Azure Blob Storage
description: 'Store self-hosted GitHub Actions caches in Azure Blob Storage, authenticated by connection string or Entra ID.'
---

Driver: `azblob`

This storage driver stores the cache in an Azure Blob Storage container.

## Configuration

The driver authenticates either with a connection string (shared key) or with an account name and Entra ID credentials from the environment (workload identity, `AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/`AZURE_CLIENT_SECRET`, or managed identity). Set one or the other, not both.

The container must already exist. The server does not create it and fails on startup if it is missing.

### `docker-compose` connection string

```yaml title="docker-compose.yml"
services:
  cache-server:
    image: ghcr.io/falcondev-oss/github-actions-cache-server:latest
    ports:
      - '3000:3000'
    environment:
      API_BASE_URL: http://localhost:3000

      STORAGE_DRIVER: azblob
      STORAGE_AZBLOB_CONTAINER: gh-actions-cache
      STORAGE_AZBLOB_CONNECTION_STRING: DefaultEndpointsProtocol=https;AccountName=mystorageaccount;AccountKey=...;EndpointSuffix=core.windows.net
    volumes:
      - cache-data:/app/.data

volumes:
  cache-data:
```

### `docker-compose` Entra ID

This example assumes credentials are provided by the environment, e.g. a [managed identity](https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/overview) or `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_CLIENT_SECRET`.

```yaml title="docker-compose.yml"
services:
  cache-server:
    image: ghcr.io/falcondev-oss/github-actions-cache-server:latest
    ports:
      - '3000:3000'
    environment:
      API_BASE_URL: http://localhost:3000

      STORAGE_DRIVER: azblob
      STORAGE_AZBLOB_CONTAINER: gh-actions-cache
      STORAGE_AZBLOB_ACCOUNT: mystorageaccount
    volumes:
      - cache-data:/app/.data

volumes:
  cache-data:
```

### Helm

Set the container and, for Entra ID auth, the account in `values.yaml`:

```yaml title="values.yaml"
config:
  storage:
    driver: azblob
    azblob:
      container: gh-actions-cache
      account: mystorageaccount
      # endpoint: https://mystorageaccount.blob.core.windows.net
```

For a connection string, leave `account` and `endpoint` unset and pass `STORAGE_AZBLOB_CONNECTION_STRING` through a Secret referenced by `existingSecret`. Never put it in `values.yaml`.

```yaml title="values.yaml"
config:
  storage:
    driver: azblob
    azblob:
      container: gh-actions-cache

existingSecret: cache-server-secrets # contains STORAGE_AZBLOB_CONNECTION_STRING
```

For [AKS workload identity](https://learn.microsoft.com/en-us/azure/aks/workload-identity-overview), annotate the service account with the identity's client ID and label the pods:

```yaml title="values.yaml"
serviceAccount:
  annotations:
    azure.workload.identity/client-id: <client-id>

podLabels:
  azure.workload.identity/use: 'true'
```

### Environment Variables

Don't forget to set the `STORAGE_DRIVER` environment variable to `azblob` to use the Azure Blob Storage driver.

#### `STORAGE_AZBLOB_CONTAINER`

Example: `gh-actions-cache`

The name of the blob container used for storage. Always required.

#### `STORAGE_AZBLOB_CONNECTION_STRING`

Example: `DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net`

Storage account [connection string](https://learn.microsoft.com/en-us/azure/storage/common/storage-configure-connection-string) with a shared key. The account and endpoint are taken from it, so `STORAGE_AZBLOB_ACCOUNT` and `STORAGE_AZBLOB_ENDPOINT` must not be set.

#### `STORAGE_AZBLOB_ACCOUNT`

Example: `mystorageaccount`

The storage account name. Required when not using a connection string. Authenticates with Entra ID credentials from the environment.

#### `STORAGE_AZBLOB_ENDPOINT`

Example: `https://mystorageaccount.blob.core.windows.net`

The Blob service endpoint. Optional, defaults to `https://<account>.blob.core.windows.net`. Only used together with `STORAGE_AZBLOB_ACCOUNT`.

## Minimal permissions

All cache objects live under the `gh-actions-cache/` prefix in the container. A connection string carries full account access, so this only applies to Entra ID auth.

| Role                                                                                                                                                    | Scope                | Used for                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------- |
| [Storage Blob Data Contributor](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/storage#storage-blob-data-contributor) | Container or account | Reading, writing, listing and deleting cache blobs               |
| [Storage Blob Delegator](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/storage#storage-blob-delegator)               | Account              | Signing SAS URLs, only if Contributor is scoped to the container |

Part uploads and direct downloads (`ENABLE_DIRECT_DOWNLOADS`) use SAS URLs signed with a [user delegation key](https://learn.microsoft.com/en-us/rest/api/storageservices/create-user-delegation-sas#assign-permissions-with-rbac). Requesting that key is an account-level operation: Storage Blob Data Contributor assigned on the account covers it, but if it is assigned on the container only, also grant Storage Blob Delegator on the account. With a connection string, URLs are signed locally with the shared key. If signing fails, uploads fall back to block uploads through the server's credentials.
