#!/bin/bash
set -e

# WhatsApp Dashboard - Deploy to S3 + CloudFront
# Usage: ./deploy-s3.sh [s3-bucket-name] [cloudfront-distribution-id]

BUCKET_NAME=${1:-"whatsapp-dashboard-afterlife"}
CLOUDFRONT_ID=${2:-""}

echo "🚀 Building Next.js static export..."
npm run build

echo "📦 Uploading to S3: s3://${BUCKET_NAME}"
aws s3 sync out/ s3://${BUCKET_NAME}/ \
  --delete \
  --cache-control "public, max-age=31536000, immutable" \
  --exclude "*.html" \
  --exclude "404.html"

# HTML files should not be cached
aws s3 sync out/ s3://${BUCKET_NAME}/ \
  --cache-control "public, max-age=0, must-revalidate" \
  --exclude "*" \
  --include "*.html"

echo "✅ Upload complete!"

if [ -n "$CLOUDFRONT_ID" ]; then
  echo "🔄 Invalidating CloudFront cache..."
  aws cloudfront create-invalidation \
    --distribution-id ${CLOUDFRONT_ID} \
    --paths "/*"
  echo "✅ CloudFront invalidation started!"
else
  echo "⚠️  No CloudFront distribution ID provided. Skipping cache invalidation."
  echo "   Run: aws cloudfront create-invalidation --distribution-id YOUR_ID --paths '/*'"
fi

echo ""
echo "🎉 Deployment complete!"
echo "   S3 Bucket: s3://${BUCKET_NAME}"
echo "   CloudFront: ${CLOUDFRONT_ID:-'(not configured)'}"
