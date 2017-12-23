# docker-to-cloudwatch-metrics
Send docker metrics to CloudWatch

## Example
```
docker run -d --name cloudwatch-metrics -v /var/run/docker.sock:/var/run/docker.sock:ro reflectivecode/docker-to-cloudwatch-metrics
```