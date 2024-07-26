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

          // Check if the request is for a file in the static directory
          if (uri.startsWith('/static/')) {
            // If the URI doesn't end with a file extension, append 'index.html'
            if (!uri.includes('.')) {
              request.uri = uri.replace(/\/?$/, '/') + 'index.html';
            }
          }

          return request;
        }
      `,
        ),
      },
    );

    const distribution = new Distribution(this, "NuxtDistribution", {
      defaultBehavior: {
        origin: new FunctionUrlOrigin(functionUrl),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      additionalBehaviors: {
        "_nuxt/*": {
          origin: new S3Origin(staticBucket, { originAccessIdentity }),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        },
        "static/*": {
          origin: new S3Origin(staticBucket, { originAccessIdentity }),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_OPTIMIZED,
          functionAssociations: [
            {
              function: urlRewriteFunction,
              eventType: FunctionEventType.VIEWER_REQUEST,
            },
          ],
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
