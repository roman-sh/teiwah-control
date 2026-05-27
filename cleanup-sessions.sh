#!/bin/bash

# ==============================================================================
# Teiwah Kubernetes Cleanup Script
# ==============================================================================
# This script finds all running WhatsApp session pods in the local k3d cluster
# and systematically deletes all of their associated resources (Deployment, 
# Service, Ingress, and Middleware). 
# 
# Usage: ./cleanup-sessions.sh
# ==============================================================================

echo "🔍 Searching for active session deployments in the default namespace..."

# 1. We grab the names of all Deployments in the 'default' namespace.
# Since our k3d cluster isolates system components in 'kube-system', 
# any deployment in 'default' belongs to a user session.
SESSION_IDS=$(kubectl get deployments -n default -o jsonpath='{.items[*].metadata.name}')

# Check if there are any sessions to delete
if [ -z "$SESSION_IDS" ]; then
  echo "✅ No active sessions found. The cluster is clean!"
  exit 0
fi

# 2. Loop through every session ID we found and delete its resources
for SESSION_ID in $SESSION_IDS; do
  echo "----------------------------------------------------"
  echo "🧹 Cleaning up session: $SESSION_ID"
  echo "----------------------------------------------------"

  # Delete the main Pod Deployment
  echo "  -> Deleting Deployment..."
  kubectl delete deployment $SESSION_ID -n default --ignore-not-found

  # Delete the internal routing Service
  echo "  -> Deleting Service..."
  kubectl delete service $SESSION_ID -n default --ignore-not-found

  # Delete the Traefik IngressRoute that maps the URL to the Service
  echo "  -> Deleting Ingress..."
  kubectl delete ingress $SESSION_ID -n default --ignore-not-found

  # Delete the custom Traefik Middleware that strips the /sessions/:id prefix
  # Note: The middleware is always named with a '-strip' suffix
  echo "  -> Deleting Traefik Middleware..."
  kubectl delete middleware $SESSION_ID-strip -n default --ignore-not-found

done

echo "----------------------------------------------------"
echo "🎉 Cleanup complete! All session resources have been removed from the cluster."
echo "👉 Note: Don't forget to manually clear your Supabase database records!"