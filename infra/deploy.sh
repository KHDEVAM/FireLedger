#!/usr/bin/env bash
# Deploy FireLedger to AWS with the plain AWS CLI (no SAM CLI needed).
#
#   bash infra/deploy.sh backend     # Lambda functions, cache bucket, schedule (CloudFormation)
#   bash infra/deploy.sh frontend    # build web/ and publish it to Amplify Hosting
#   bash infra/deploy.sh all
#
# Requirements: AWS CLI v2 logged in (aws login / aws configure sso), Node 20+, Python 3.
# The FIRMS MAP_KEY must already be in SSM Parameter Store (never in this repository):
#   aws ssm put-parameter --name /fireledger/FIRMS_MAP_KEY --type SecureString --value <KEY> --region eu-west-3
#
# Without a connected Git repository Amplify does not build by itself, so "frontend"
# uploads the built site as a zip (manual deployment). Connect the repository in the
# Amplify console later to get automatic deploys on every push (amplify.yml is ready).
set -euo pipefail

export AWS_DEFAULT_REGION="${AWS_REGION:-eu-west-3}"
export AWS_PAGER=""
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: keep names such as /fireledger/... intact
STACK="${STACK:-fireledger}"
APP_NAME="${APP_NAME:-fireledger}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.aws-sam"
mkdir -p "$WORK"
# native form of the path for Python and file:// arguments (Git Bash on Windows)
WORK_NATIVE="$(cygpath -m "$WORK" 2>/dev/null || echo "$WORK")"
cd "$ROOT"
# first interpreter that really runs (on Windows "python3" can be a Store placeholder)
PY=""
for candidate in python3 python py; do
  if "$candidate" -c "" >/dev/null 2>&1; then PY="$candidate"; break; fi
done
[ -n "$PY" ] || { echo "Python 3 is required"; exit 1; }

backend() {
  local account bucket
  account="$(aws sts get-caller-identity --query Account --output text)"
  bucket="fireledger-deploy-$account"
  aws s3api head-bucket --bucket "$bucket" 2>/dev/null ||
    aws s3api create-bucket --bucket "$bucket" --create-bucket-configuration "LocationConstraint=$AWS_DEFAULT_REGION" >/dev/null
  aws s3api put-public-access-block --bucket "$bucket" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  find api -name "__pycache__" -type d -prune -exec rm -rf {} +
  aws cloudformation package --template-file infra/template.yaml --s3-bucket "$bucket" --s3-prefix fireledger \
    --output-template-file "$WORK_NATIVE/packaged.yaml" >/dev/null
  aws cloudformation deploy --template-file "$WORK_NATIVE/packaged.yaml" --stack-name "$STACK" \
    --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --no-fail-on-empty-changeset
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output text >"$WORK/outputs.txt"
  echo "backend deployed; function URLs are in .aws-sam/outputs.txt"
}

frontend() {
  [ -f "$WORK/outputs.txt" ] || { echo "run 'backend' first"; exit 1; }
  # reinstall only when needed: npm ci wipes node_modules and fails if a dev server holds files open
  (cd web && { [ -d node_modules/vite ] || npm ci; } && npm run build)

  # Rewrites: Amplify needs the exact path and the "/<*>" form (a bare "/api/nrt<*>" does not match).
  "$PY" - "$WORK_NATIVE" <<'PYEOF'
import json, pathlib, sys, zipfile
work = pathlib.Path(sys.argv[1])
urls = dict(line.split()[:2] for line in (work / "outputs.txt").read_text().splitlines() if line.strip())
rules = []
for name, key in [("nrt", "NrtFunctionUrl"), ("weather", "WeatherFunctionUrl"), ("export", "ExportFunctionUrl")]:
    rules.append({"source": f"/api/{name}", "target": urls[key], "status": "200"})
    rules.append({"source": f"/api/{name}/<*>", "target": urls[key] + "<*>", "status": "200"})
rules += [
    {"source": "https://www.fireledger.earth", "target": "https://fireledger.earth", "status": "302"},
    {"source": "/<*>", "target": "/404.html", "status": "404-200"},
]
(work / "rules.json").write_text(json.dumps(rules, indent=1))
dist = work.parent / "web" / "dist"
with zipfile.ZipFile(work / "site.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(dist.rglob("*")):
        if f.is_file():
            z.write(f, f.relative_to(dist).as_posix())
PYEOF

  local app job url status
  app="$(aws amplify list-apps --query "apps[?name=='$APP_NAME'].appId | [0]" --output text)"
  if [ "$app" = "None" ] || [ -z "$app" ]; then
    app="$(aws amplify create-app --name "$APP_NAME" --platform WEB --query app.appId --output text)"
    aws amplify create-branch --app-id "$app" --branch-name main --stage PRODUCTION >/dev/null
  fi
  aws amplify update-app --app-id "$app" --custom-rules "file://$WORK_NATIVE/rules.json" --custom-headers "file://customHttp.yml" >/dev/null

  # a deployment that was created but never started blocks the next one: cancel leftovers
  for stuck in $(aws amplify list-jobs --app-id "$app" --branch-name main \
      --query "jobSummaries[?status=='PENDING'].jobId" --output text | tr -d '[:cntrl:]'); do
    aws amplify stop-job --app-id "$app" --branch-name main --job-id "$stuck" >/dev/null
  done
  aws amplify create-deployment --app-id "$app" --branch-name main --output json >"$WORK/deployment.json"
  # [:cntrl:] strips the carriage return that Windows tools append
  job="$("$PY" -c "import json,sys; print(json.load(open(sys.argv[1]))['jobId'])" "$WORK_NATIVE/deployment.json" | tr -d '[:cntrl:]')"
  url="$("$PY" -c "import json,sys; print(json.load(open(sys.argv[1]))['zipUploadUrl'])" "$WORK_NATIVE/deployment.json" | tr -d '[:cntrl:]')"
  rm -f "$WORK/deployment.json"
  # shell redirect, not "-o /dev/null": a native Windows curl cannot open /dev/null
  curl -sS --fail -T "$WORK_NATIVE/site.zip" "$url" >/dev/null
  aws amplify start-deployment --app-id "$app" --branch-name main --job-id "$job" >/dev/null
  for _ in $(seq 1 60); do
    sleep 6
    status="$(aws amplify get-job --app-id "$app" --branch-name main --job-id "$job" --query job.summary.status --output text)"
    [ "$status" = "SUCCEED" ] || [ "$status" = "FAILED" ] && break
  done
  echo "Amplify job $job: $status  ->  https://main.$app.amplifyapp.com"
  [ "$status" = "SUCCEED" ]
}

case "${1:-all}" in
  backend) backend ;;
  frontend) frontend ;;
  all) backend; frontend ;;
  *) echo "usage: bash infra/deploy.sh [backend|frontend|all]"; exit 2 ;;
esac
