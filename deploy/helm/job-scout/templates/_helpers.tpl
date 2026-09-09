{{- define "job-scout.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "job-scout.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "job-scout.name" . -}}
{{- end -}}
{{- end -}}

{{- define "job-scout.labels" -}}
app.kubernetes.io/name: {{ include "job-scout.name" . }}
app.kubernetes.io/instance: {{ include "job-scout.fullname" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels: name + instance so two releases can live in the same namespace. */}}
{{- define "job-scout.selectorLabels" -}}
app.kubernetes.io/name: {{ include "job-scout.name" . }}
app.kubernetes.io/instance: {{ include "job-scout.fullname" . }}
{{- end -}}

{{/* Shared pod spec bits: image pull secrets, affinity, node selector, tolerations */}}
{{- define "job-scout.podScheduling" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* envFrom shared by api, worker and cron containers */}}
{{- define "job-scout.envFrom" -}}
envFrom:
  - configMapRef:
      name: {{ include "job-scout.fullname" . }}-config
  - secretRef:
      name: {{ .Values.existingSecret }}
{{- end -}}

{{/* PodSecurity "restricted" compliant contexts. Image runs as uid 10001. */}}
{{- define "job-scout.podSecurityContext" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  fsGroup: 10001
  seccompProfile:
    type: RuntimeDefault
{{- end -}}

{{- define "job-scout.containerSecurityContext" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: false
  capabilities:
    drop: ["ALL"]
{{- end -}}

{{/* Pod annotations that make the k8s-monitoring Alloy pick up /metrics (see docs/OBSERVABILITY.md). */}}
{{- define "job-scout.metricsAnnotations" -}}
{{- if .Values.metrics.enabled }}
prometheus.io/scrape: "true"
prometheus.io/port: {{ .Values.metrics.port | quote }}
prometheus.io/path: /metrics
k8s.grafana.com/scrape: "true"
k8s.grafana.com/metrics_path: /metrics
k8s.grafana.com/metrics_portNumber: {{ .Values.metrics.port | quote }}
k8s.grafana.com/metrics_scrapeInterval: {{ .Values.metrics.scrapeInterval | quote }}
k8s.grafana.com/job: {{ .Values.metrics.job | quote }}
{{- end }}
{{- end -}}

{{- define "job-scout.metricsPort" -}}
{{- if .Values.metrics.enabled }}
- name: metrics
  containerPort: {{ .Values.metrics.port }}
{{- end }}
{{- end -}}

{{- define "job-scout.metricsEnv" -}}
- name: METRICS_PORT
  value: {{ .Values.metrics.enabled | ternary (.Values.metrics.port | toString) "0" | quote }}
{{- end -}}
