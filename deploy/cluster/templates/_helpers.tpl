{{- define "kross.labels" -}}
app.kubernetes.io/name: kross
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "kross.namespace" -}}
{{- default .Release.Namespace .Values.namespace -}}
{{- end }}
