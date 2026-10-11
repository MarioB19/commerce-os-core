# SDK_IMAGE must be the reviewed linux/amd64 gcloud image @sha256 digest.
# No build/pull takes place on the production VM or paid CI.
ARG SDK_IMAGE
FROM ${SDK_IMAGE}
ARG SOURCE_SHA
ENV COMMERCE_BUILD_SOURCE_SHA=${SOURCE_SHA}
LABEL org.opencontainers.image.revision=${SOURCE_SHA}
WORKDIR /opt/commerce
COPY scripts/b02-backup-gcp.py scripts/b02-backup-ci.py scripts/b02-backup-root.py scripts/b02_backup_contract.py scripts/b02-portal-capsule.mjs scripts/ephemeral_os_login.py ./scripts/
RUN python3 -c "import os,re; s=os.environ['COMMERCE_BUILD_SOURCE_SHA']; assert re.fullmatch('[a-f0-9]{40}',s); open('SOURCE_SHA','w').write(s+'\n')" \
    && command -v gcloud && command -v ssh && command -v scp && command -v ssh-keygen \
    && mkdir /work && chmod 700 /work
ENV PYTHONDONTWRITEBYTECODE=1
# Cloud Run command replaces ENTRYPOINT; omitted args inherit CMD. Keep CMD
# empty so the reviewed Job.command is never appended to itself.
ENTRYPOINT ["python3", "-B", "/opt/commerce/scripts/b02-backup-gcp.py"]
CMD []
