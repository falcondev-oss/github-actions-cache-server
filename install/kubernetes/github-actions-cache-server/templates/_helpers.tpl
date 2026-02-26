{{/*
Expand the name of the chart.
*/}}
{{- define "github-actions-cache-server.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "github-actions-cache-server.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "github-actions-cache-server.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "github-actions-cache-server.labels" -}}
helm.sh/chart: {{ include "github-actions-cache-server.chart" . }}
{{ include "github-actions-cache-server.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "github-actions-cache-server.selectorLabels" -}}
app.kubernetes.io/name: {{ include "github-actions-cache-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "github-actions-cache-server.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "github-actions-cache-server.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
PVC name
*/}}
{{- define "github-actions-cache-server.pvcName" -}}
{{ include "github-actions-cache-server.fullname" . }}-data
{{- end }}

{{/*
Determine if PVC should be enabled.
If persistentVolumeClaim.enabled is explicitly set (true/false), use that value.
Otherwise, auto-enable when storage driver is "filesystem" or db driver is "sqlite".
*/}}
{{- define "github-actions-cache-server.pvcEnabled" -}}
{{- if kindIs "bool" .Values.persistentVolumeClaim.enabled -}}
  {{- .Values.persistentVolumeClaim.enabled -}}
{{- else -}}
  {{- or (eq .Values.config.storage.driver "filesystem") (eq .Values.config.db.driver "sqlite") -}}
{{- end -}}
{{- end }}

{{/*
Check if multiple replicas are possible (autoscaling enabled or replicaCount > 1).
*/}}
{{- define "github-actions-cache-server.multipleReplicas" -}}
{{- if or (and .Values.autoscaling.enabled (gt (.Values.autoscaling.maxReplicas | int) 1)) (gt (.Values.replicaCount | int) 1) -}}
true
{{- else -}}
false
{{- end -}}
{{- end }}

{{/*
Effective PVC access modes.
Automatically switches to ReadWriteMany when multiple replicas are possible
and the filesystem storage driver is used, to prevent errors when multiple
pods attach to the same volume.
*/}}
{{- define "github-actions-cache-server.pvcAccessModes" -}}
{{- if and (eq (include "github-actions-cache-server.multipleReplicas" .) "true") (eq .Values.config.storage.driver "filesystem") -}}
- ReadWriteMany
{{- else -}}
{{ toYaml .Values.persistentVolumeClaim.accessModes }}
{{- end -}}
{{- end }}

{{/*
Validate configuration. Fails if incompatible settings are detected.
*/}}
{{- define "github-actions-cache-server.validate" -}}
{{- if and (eq .Values.config.db.driver "sqlite") (eq (include "github-actions-cache-server.multipleReplicas" .) "true") -}}
{{- fail "SQLite database driver cannot be used with multiple replicas (autoscaling enabled or replicaCount > 1). SQLite does not support concurrent access from multiple pods. Please switch to 'postgres' or 'mysql' database driver." -}}
{{- end -}}
{{- end }}

{{/*
Generate environment variables from config values.
*/}}
{{- define "github-actions-cache-server.env" -}}
- name: PORT
  value: "3000"
- name: API_BASE_URL
  value: {{ default (printf "http://%s.%s.svc.cluster.local" (include "github-actions-cache-server.fullname" .) .Release.Namespace) .Values.config.apiBaseUrl | quote }}
- name: ENABLE_DIRECT_DOWNLOADS
  value: {{ .Values.config.enableDirectDownloads | quote }}
- name: CACHE_CLEANUP_OLDER_THAN_DAYS
  value: {{ .Values.config.cacheCleanupOlderThanDays | quote }}
{{- if .Values.config.disableCleanupJobs }}
- name: DISABLE_CLEANUP_JOBS
  value: "true"
{{- end }}
{{- if .Values.config.debug }}
- name: DEBUG
  value: "true"
{{- end }}
{{- if .Values.config.managementApiKey }}
- name: MANAGEMENT_API_KEY
  value: {{ .Values.config.managementApiKey | quote }}
{{- end }}
{{/* Storage driver */}}
- name: STORAGE_DRIVER
  value: {{ .Values.config.storage.driver | quote }}
{{- if eq .Values.config.storage.driver "filesystem" }}
- name: STORAGE_FILESYSTEM_PATH
  value: {{ .Values.config.storage.filesystem.path | quote }}
{{- else if eq .Values.config.storage.driver "s3" }}
- name: STORAGE_S3_BUCKET
  value: {{ .Values.config.storage.s3.bucket | quote }}
{{- if .Values.config.storage.s3.region }}
- name: AWS_REGION
  value: {{ .Values.config.storage.s3.region | quote }}
{{- end }}
{{- if .Values.config.storage.s3.endpointUrl }}
- name: AWS_ENDPOINT_URL
  value: {{ .Values.config.storage.s3.endpointUrl | quote }}
{{- end }}
{{- if .Values.config.storage.s3.accessKeyId }}
- name: AWS_ACCESS_KEY_ID
  value: {{ .Values.config.storage.s3.accessKeyId | quote }}
{{- end }}
{{- if .Values.config.storage.s3.secretAccessKey }}
- name: AWS_SECRET_ACCESS_KEY
  value: {{ .Values.config.storage.s3.secretAccessKey | quote }}
{{- end }}
{{- else if eq .Values.config.storage.driver "gcs" }}
- name: STORAGE_GCS_BUCKET
  value: {{ .Values.config.storage.gcs.bucket | quote }}
{{- if .Values.config.storage.gcs.serviceAccountKey }}
- name: STORAGE_GCS_SERVICE_ACCOUNT_KEY
  value: {{ .Values.config.storage.gcs.serviceAccountKey | quote }}
{{- end }}
{{- if .Values.config.storage.gcs.endpoint }}
- name: STORAGE_GCS_ENDPOINT
  value: {{ .Values.config.storage.gcs.endpoint | quote }}
{{- end }}
{{- end }}
{{/* Database driver */}}
- name: DB_DRIVER
  value: {{ .Values.config.db.driver | quote }}
{{- if eq .Values.config.db.driver "sqlite" }}
- name: DB_SQLITE_PATH
  value: {{ .Values.config.db.sqlite.path | quote }}
{{- else if eq .Values.config.db.driver "postgres" }}
{{- if .Values.config.db.postgres.url }}
- name: DB_POSTGRES_URL
  value: {{ .Values.config.db.postgres.url | quote }}
{{- else }}
- name: DB_POSTGRES_DATABASE
  value: {{ .Values.config.db.postgres.database | quote }}
- name: DB_POSTGRES_HOST
  value: {{ .Values.config.db.postgres.host | quote }}
- name: DB_POSTGRES_PORT
  value: {{ .Values.config.db.postgres.port | quote }}
- name: DB_POSTGRES_USER
  value: {{ .Values.config.db.postgres.user | quote }}
{{- if .Values.config.db.postgres.password }}
- name: DB_POSTGRES_PASSWORD
  value: {{ .Values.config.db.postgres.password | quote }}
{{- end }}
{{- end }}
{{- else if eq .Values.config.db.driver "mysql" }}
- name: DB_MYSQL_DATABASE
  value: {{ .Values.config.db.mysql.database | quote }}
- name: DB_MYSQL_HOST
  value: {{ .Values.config.db.mysql.host | quote }}
- name: DB_MYSQL_PORT
  value: {{ .Values.config.db.mysql.port | quote }}
- name: DB_MYSQL_USER
  value: {{ .Values.config.db.mysql.user | quote }}
{{- if .Values.config.db.mysql.password }}
- name: DB_MYSQL_PASSWORD
  value: {{ .Values.config.db.mysql.password | quote }}
{{- end }}
{{- end }}
{{- end }}
