# Remote Docker host: Azure and AWS

Code can run its sandboxes on a Linux VM you own instead of your computer. You give Code SSH access to the VM; Code prepares it (Docker and gVisor) and then runs every Code session there.

## What runs where

| On your computer | On the VM |
|---|---|
| Harness, the model connection, sessions | Docker Engine with the gVisor runtime (`runsc`) |
| Your GitHub token and the `gh` CLI | One gVisor container per Code session, as a non-root user |
| A bare Git mirror per session: clone and push happen here | The session checkout, in a Docker volume |
| Code's SSH config, the pinned host key, the key file you point to | The egress proxy and its allowlist |

- **Your GitHub token never reaches the VM.** Your computer clones into its own mirror and sends the sandbox a Git bundle. To push, the sandbox streams a bundle back, your computer checks it with `git bundle verify` and pushes from the mirror.
- **The agent's network traffic leaves from the VM**, through the same egress proxy and allowlist as locally, including the hosts you approve per session.
- **Code uses its own SSH config** (`<dataDir>/remote/ssh_config`). It never reads or changes `~/.ssh/config` or `~/.ssh/known_hosts`. It pins the host key you give (any other key is refused), uses only the key file you name, never prompts, forwards nothing (no agent, no ports, no X11), and reuses one connection.
- **Docker access on the VM is root on the VM.** Use a VM dedicated to Code, not one that holds other data.
- **Not available remotely:** extra read-only folders (they are on your computer; Code skips them and says so in the timeline). Checkouts are not visible on your computer; deleting the VM loses work that was not pushed.

## What you need

- A Linux VM: Ubuntu 22.04 or 24.04, Debian 12, or Amazon Linux 2023. 2 vCPUs and 8 GB of memory are enough for a few sessions; the worker image needs about 2 GB of disk.
- SSH key login for a user with passwordless `sudo` (the default on Azure and AWS images). `sudo` is used only once, by **Prepare the VM**.
- SSH reachable from your computer only (a firewall rule for your IP address).
- The VM's host key fingerprint, read out-of-band (from the cloud provider, not over the network you are about to trust). The steps below show how.

Commands below use the Azure CLI (`az`) and the AWS CLI (`aws`), already logged in, and follow each CLI's reference; they have not been run end to end yet, so check each step's output. The same can be done in each provider's web console.

```sh
MYIP=$(curl -s https://checkip.amazonaws.com)   # your public IP address
ssh-keygen -t ed25519 -f ~/.ssh/dsh-code-vm -N ''   # a key just for this VM (or use one you have)
```

## Azure

```sh
az group create -n dsh-code -l westeurope
az vm create -g dsh-code -n dsh-code-vm --image Ubuntu2404 --size Standard_B2ms \
  --admin-username azureuser --ssh-key-values ~/.ssh/dsh-code-vm.pub --nsg-rule NONE
az network nsg rule create -g dsh-code --nsg-name dsh-code-vmNSG -n ssh-from-me --priority 1000 \
  --source-address-prefixes "$MYIP/32" --destination-port-ranges 22 --protocol Tcp --access Allow
az vm show -d -g dsh-code -n dsh-code-vm --query publicIps -o tsv          # the host
az vm run-command invoke -g dsh-code -n dsh-code-vm --command-id RunShellScript \
  --scripts "ssh-keygen -l -E sha256 -f /etc/ssh/ssh_host_ed25519_key.pub"  # the fingerprint
```

`--nsg-rule NONE` keeps `az vm create` from opening SSH to the whole internet; the next rule opens it to your address only. `az vm run-command` runs inside the VM through Azure itself, so the fingerprint it prints is the VM's own.

Settings > Code > Remote Docker host:

| Field | Value |
|---|---|
| Host | the public IP from `az vm show` |
| SSH port | `22` |
| SSH login | `azureuser` |
| Private key file | the absolute path of `~/.ssh/dsh-code-vm`, for example `/Users/you/.ssh/dsh-code-vm` |
| Host key fingerprint | the `SHA256:…` value from `az vm run-command` (ED25519) |

Delete everything afterwards: `az group delete -n dsh-code --yes`.

## AWS

```sh
aws ec2 import-key-pair --key-name dsh-code --public-key-material fileb://$HOME/.ssh/dsh-code-vm.pub
SG=$(aws ec2 create-security-group --group-name dsh-code --description "dsh-code VM" --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22 --cidr "$MYIP/32"
AMI=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
ID=$(aws ec2 run-instances --image-id "$AMI" --instance-type t3.large --key-name dsh-code --security-group-ids "$SG" \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30}' --query 'Instances[0].InstanceId' --output text)
aws ec2 wait instance-running --instance-ids "$ID"
aws ec2 describe-instances --instance-ids "$ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text   # the host
aws ec2 get-console-output --instance-id "$ID" --latest --output text | sed -n '/BEGIN SSH HOST KEY FINGERPRINTS/,/END SSH HOST KEY FINGERPRINTS/p'
```

The console output comes from the instance through AWS, and cloud-init prints the host key fingerprints there on first boot (it can take a few minutes to appear). Use the `SHA256:…` value marked `(ED25519)`.

Settings > Code > Remote Docker host: the public IP, port `22`, login `ubuntu` (`ec2-user` on Amazon Linux 2023), the key file, the fingerprint.

Delete everything afterwards: `aws ec2 terminate-instances --instance-ids "$ID"`, then (once it is terminated) `aws ec2 delete-security-group --group-id "$SG"` and `aws ec2 delete-key-pair --key-name dsh-code`.

## First run

1. Save Settings > Code. Code reloads with the remote host.
2. Choose **Code mode** in a session. The setup notice above the composer checks the connection first: it pins the host key (a wrong fingerprint is refused, and the notice lists what the server offered) and logs in once.
3. On a fresh VM it reports that Docker is missing. **Prepare the VM** logs in over SSH and, with `sudo`, installs Docker Engine and gVisor from the distribution's and gVisor's package repositories (on Amazon Linux and Fedora: gVisor's sha512-checked release tarball, a path that has not run yet), registers `runsc` with Docker and adds your login to the `docker` group. It leaves anything already installed as it is.
4. **Build worker image** builds `dsh-code-worker` on the VM (the build context is sent over the same SSH connection; a few minutes).
5. Choose a repository with **+ → Repository** and send a message.

To confirm it worked, open the session's **Environment** tab: it shows **Runs on: remote VM** and **Checkout: Docker volume**, and the provisioning timeline lists **Creating the checkout volume and importing the branch**. Ask the agent to run `dmesg | head -n 1` (prints `Starting gVisor…`) and `id -u` (prints `1000`).

## Switching back

Clear **Host** in Settings > Code to run on your computer again. Sessions started on the VM stay there and show as offline; they work again when you switch back. Deleting such a session while Code uses your computer removes its record and mirror here; its container and volume on the VM are removed the next time Code starts with that VM.

## Testing Code against a remote host

The live test `tests/integration/remote.docker.test.ts` runs the same steps against any VM:

```sh
DSH_CODE_REMOTE_TESTS=1 DSH_CODE_REMOTE_HOST=<ip> DSH_CODE_REMOTE_PORT=22 DSH_CODE_REMOTE_USER=azureuser \
DSH_CODE_REMOTE_KEY=$HOME/.ssh/dsh-code-vm DSH_CODE_REMOTE_HOSTKEY=SHA256:… pnpm run test:docker
```

It needs Docker, gVisor and the worker image on the VM already. On macOS, the Colima VM's own SSH server is a remote host too (`colima ssh-config -p dsh` gives the port, login and key; read the fingerprint with `colima ssh -p dsh -- ssh-keygen -l -E sha256 -f /etc/ssh/ssh_host_ed25519_key.pub`).
