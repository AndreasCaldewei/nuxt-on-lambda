import * as cdk from "aws-cdk-lib";
import { Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Runtime, FunctionUrlAuthType } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import {
  Distribution,
  OriginAccessIdentity,
  ViewerProtocolPolicy,
  CachePolicy,
  OriginRequestPolicy,
  AllowedMethods,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
} from "aws-cdk-lib/aws-cloudfront";
import {
  S3Origin,
  FunctionUrlOrigin,
  OriginGroup,
  HttpOrigin,
} from "aws-cdk-lib/aws-cloudfront-origins";
import { Construct } from "constructs";

export class NuxtOnLambdaStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const staticBucket = new Bucket(this, "NuxtStaticBucket", {
      publicReadAccess: false,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const server = new NodejsFunction(this, "NuxtServer", {
      runtime: Runtime.NODEJS_18_X,
      entry: "../.output/server/index.mjs",
      handler: "handler",
      memorySize: 1024,
      timeout: Duration.seconds(10),
    });

    const functionUrl = server.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
    });

    const originAccessIdentity = new OriginAccessIdentity(this, "OAI");
    staticBucket.grantRead(originAccessIdentity);

    // CloudFront Function for URL rewriting
    const urlRewriteFunction = new CloudFrontFunction(
      this,
      "UrlRewriteFunction",
      {
        code: FunctionCode.fromInline(
          /* Javascript */
          `
          function handler(event) {
              var request = event.request;
              var uri = request.uri;
              if (!uri.includes('.')) {
                  request.uri = uri.replace(/\/?$/, '/') + 'index.html';
              }
              return request;
          }
      `,
        ),
      },
    );

    const staticDistributaion = new Distribution(
      this,
      "NuxtStaticDistribution",
      {
        defaultRootObject: "index.html",
        defaultBehavior: {
          origin: new S3Origin(staticBucket, { originAccessIdentity }),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          functionAssociations: [
            {
              function: urlRewriteFunction,
              eventType: FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
      },
    );

    const origin = new OriginGroup({
      primaryOrigin: new HttpOrigin(staticDistributaion.domainName),
      fallbackOrigin: new FunctionUrlOrigin(functionUrl),
      fallbackStatusCodes: [403, 404],
    });

    const distribution = new Distribution(this, "NuxtDistribution", {
      defaultBehavior: {
        origin: origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
      },
      additionalBehaviors: {
        "/": {
          origin: new FunctionUrlOrigin(functionUrl),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        },
        "*.*": {
          origin: new S3Origin(staticBucket, { originAccessIdentity }),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        },
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/error.html",
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/error.html",
        },
      ],
    });

    new BucketDeployment(this, "DeployStaticAssets", {
      sources: [Source.asset("../.output/public")],
      destinationBucket: staticBucket,
      distribution: distribution,
      distributionPaths: ["/*"],
    });

    new cdk.CfnOutput(this, "DistributionDomainName", {
      value: distribution.distributionDomainName,
      description: "CloudFront Distribution Domain Name",
    });

    new cdk.CfnOutput(this, "LambdaFunctionUrl", {
      value: functionUrl.url,
      description: "Lambda Function URL",
    });
  }
}
