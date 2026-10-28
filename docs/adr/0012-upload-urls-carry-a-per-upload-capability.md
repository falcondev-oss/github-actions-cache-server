---
status: accepted
---

# Upload URLs carry a per-upload capability

The upload id in `signed_upload_url` was the only thing a Part upload had to know, so anyone who could reach the server and guess or observe a ten digit id could write into another workflow's upload (#259, #299). `CreateCacheEntry` now appends 256 random bits as `?sig=` to the URL, like the SAS on an Azure Blob URL, and stores only its SHA-256 in `uploads.capabilityHash`. Single-shot, block and block list requests must present it; a mismatch, compared in constant time, is a 403.

`@actions/cache` and BuildKit build their requests with the Azure SDK, which keeps a SAS query, so clients need no change. We rejected HMAC-signed, expiring URLs (#259) because they need a signing secret per deployment and a rotation story, while a random capability per upload needs no configuration and dies with its upload.

The column is nullable so replicas still on the previous version can insert during a rollout. Their uploads, and uploads in flight during the upgrade, have no hash, so this version refuses their Parts: those saves fail once and the next run saves again.
