# Helm chart versions are independent from application versions

The Helm chart's SemVer version is independent of the application version it deploys. Every application release changes the chart's default application version and therefore increments the chart patch version by default; releases that include a chart-level feature or breaking change explicitly select a chart minor or major bump. This keeps chart packages uniquely versioned while allowing their compatibility contract to evolve independently of the application.
