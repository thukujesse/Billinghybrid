# Kubernetes deployment

Manifests for running JTM billing on Kubernetes (K3s on-prem or EKS), matching
the architecture doc's Phase 4 (HPA, blue/green-ready, GitOps-friendly).

```
00-namespace.yaml   jtm namespace
01-config.yaml      ConfigMap + Secrets (PLACEHOLDER values — replace!)
02-postgres.yaml    Postgres StatefulSet + PVC + headless Service
03-api.yaml         API Deployment (migrate init-container) + Service + HPA
04-web.yaml         Next.js portal Deployment + Service
05-ingress.yaml     Ingress: / -> web, /api -> api
```

## Build & load images

The manifests reference `jtm/api:latest` and `jtm/web:latest`. Build and push
to your registry (or load into a local cluster):

```bash
docker build -f api/Dockerfile -t jtm/api:latest .
docker build -f web/Dockerfile -t jtm/web:latest --build-arg NEXT_PUBLIC_API_URL=https://billing.example.com .

# kind:  kind load docker-image jtm/api:latest jtm/web:latest
# k3s:   k3s ctr images import ...   (or push to a registry)
```

## Deploy

```bash
# 1. Set real secrets first (do NOT rely on the placeholders in 01-config.yaml):
kubectl create namespace jtm
kubectl -n jtm create secret generic jtm-secrets \
  --from-literal=DATABASE_URL='postgres://jtm:STRONGPASS@jtm-db:5432/jtm' \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=MPESA_CONSUMER_KEY=... # etc.

# 2. Apply everything (kustomize-free, ordered by filename):
kubectl apply -f k8s/

kubectl -n jtm rollout status deploy/jtm-api
kubectl -n jtm get pods,svc,hpa,ingress
```

The API's migrate init-container runs migrations on each rollout (idempotent),
so a fresh database is schema-ready before the API serves traffic.

## Notes

- HPA scales the API 2→10 pods at 70% CPU (needs metrics-server).
- Object storage uses a PVC here; point `STORAGE_DIR` at a mounted bucket
  (or swap the storage adapter for S3/MinIO) in production.
- For real HA Postgres, use a managed DB or an operator (CNPG/Zalando) instead
  of the single-replica StatefulSet.
