import {
  Stack,
  StackProps,
  aws_iam as iam,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_sns as sns,
  aws_apigateway as apigateway,
  aws_lambda as lambda,
  // aws_mediaconvert as mediaconvert,
  aws_dynamodb as ddb,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as cloudfront_origins,
  Duration,
  CfnOutput,
  RemovalPolicy,
  custom_resources as cr,
  aws_logs as log,
  aws_ssm as ssm,
  aws_logs as logs,
  CustomResource
} from 'aws-cdk-lib';


import { Construct } from 'constructs';

export class UiS3UploadStack extends Stack {

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // create a source bucket
    const sourceBucket = new s3.Bucket(this, 'SourceBucket', {
      //defin cors allow all
      cors: [
        {
          allowedHeaders: ['*'],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.DELETE],
          allowedOrigins: ['*'],
          exposedHeaders: ['ETag']
        }],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // website bucket, holding the static html page
    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    // deploy the static-content to the website bucket
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset('static-content')],
      destinationBucket: websiteBucket,
    });

    // Create CloudFront OAI for CloudFront accessing the S3 bucket static files and s3 bucket policy
    const cloudfrontOAI = new cloudfront.OriginAccessIdentity(this, 'cloudfront-OAI', {});

    websiteBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [websiteBucket.arnForObjects('*')],
      principals: [new iam.CanonicalUserPrincipal(cloudfrontOAI.cloudFrontOriginAccessIdentityS3CanonicalUserId)]
    }));


    // api gateway to expose the upload function
    const api = new apigateway.RestApi(this, 'Endpoint', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['*'],
      },
    });


    // create the CloudFront distribution 
    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 403,
          responsePagePath: '/error.html',
          ttl: Duration.minutes(30),
        }
      ],
      defaultBehavior: {
        origin: new cloudfront_origins.S3Origin(websiteBucket, { originAccessIdentity: cloudfrontOAI }),
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      }
    });

    // custom resource to rewrite the static content to the website bucket
    const staticUploadFunction = new lambda.Function(this, 'UploadStaticContentFunction', {
      code: lambda.Code.fromAsset('./customResource/uploadFunction'),
      handler: 'custom-resource.on_event',
      runtime: lambda.Runtime.PYTHON_3_9,
      environment: {
        WEBSITE_BUCKET: websiteBucket.bucketName,
        API_ENDPOINT: api.url,
        DISTRIBUTION_ID: distribution.distributionId,
      },
      timeout: Duration.seconds(2 * 15)
    });
    distribution.grantCreateInvalidation(staticUploadFunction)

    // custom resource to dynamically change the API endpoint to js file
    const staticUploadProvider = new cr.Provider(this, 'StaticUploadProvider', {
      onEventHandler: staticUploadFunction,
      logRetention: log.RetentionDays.ONE_DAY
    });

    const staticUploadFunctionCustomResource = new CustomResource(this, 'StaticUploadResource', {
      serviceToken: staticUploadProvider.serviceToken,
      removalPolicy: RemovalPolicy.DESTROY,
      resourceType: 'Custom::StaticContentUploader',
    });

    staticUploadFunctionCustomResource.node.addDependency(distribution)
    websiteBucket.grantReadWrite(staticUploadFunction);

    // define a Lambda function execution role with permission to log in CloudWatch, run DetectText api and AnalyzeDoc
    const textractRole = new iam.Role(this, 'textractRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    textractRole.addToPolicy(new iam.PolicyStatement({
      resources: ['*'],
      actions: ['logs:*'],
      effect: iam.Effect.ALLOW,
    }));

    textractRole.addToPolicy(new iam.PolicyStatement({
      resources: ['*'],
      actions: ['textract:*'],
      effect: iam.Effect.ALLOW,
    }));

    textractRole.addToPolicy(new iam.PolicyStatement({
      resources: ['*'],
      actions: ['s3:*'],
      effect: iam.Effect.ALLOW,
    }));

    // Define the DDB that will store the response from lambda function
    const textractTable = new ddb.Table(this, 'textractTable', {
      partitionKey: { name: 'documentId', type: ddb.AttributeType.STRING },
    });

    // Define a lambda function that triggers a document analysis in textract
    const textractLambda = new lambda.Function(this, 'textractFunction', {
      runtime: lambda.Runtime.PYTHON_3_10,
      handler: 'app.lambda_handler',
      timeout: Duration.minutes(5),
      code: lambda.Code.fromAsset('lambda'),
      role: textractRole,
      environment: {
        S3_BUCKET_NAME: sourceBucket.bucketName,
        DDB_TABLE_NAME: textractTable.tableName,
      },
    });

    textractTable.grantWriteData(textractLambda)
    // output
    new CfnOutput(this, 'UIEndpoint', { value: distribution.distributionDomainName });

  }
}  