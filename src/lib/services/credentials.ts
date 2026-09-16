import { SecretsManagerClient, CreateSecretCommand, GetSecretValueCommand, UpdateSecretCommand, DeleteSecretCommand } from '@aws-sdk/client-secrets-manager';
import { KMSClient, CreateKeyCommand, DescribeKeyCommand } from '@aws-sdk/client-kms';
import crypto from 'crypto';

export interface StoredCredentials {
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  token?: string;
  bucket?: string;
  org?: string;
  ssl?: boolean;
  apiKey?: string;
  [key: string]: any;
}

export class CredentialService {
  private secretsClient: SecretsManagerClient;
  private kmsClient: KMSClient;

  constructor() {
    this.secretsClient = new SecretsManagerClient({
      region: process.env.AWS_REGION || 'eu-west-1',
    });

    this.kmsClient = new KMSClient({
      region: process.env.AWS_REGION || 'eu-west-1',
    });
  }

  async storeCredentials(customerId: string, credentials: StoredCredentials): Promise<string> {
    // Create customer-specific KMS key if not exists
    const kmsKeyId = await this.getOrCreateCustomerKMSKey(customerId);
    
    // Generate unique secret name
    const secretName = `heliosiq/customers/${customerId}/connection-${crypto.randomUUID()}`;
    
    // Store encrypted credentials
    const command = new CreateSecretCommand({
      Name: secretName,
      Description: `HeliosIQ data connection credentials for customer ${customerId}`,
      SecretString: JSON.stringify(credentials),
      KmsKeyId: kmsKeyId,
      // EU data residency: keep customer credentials in eu-west-1 only. No
      // cross-region replica (a US replica previously leaked creds out of the EU).
      // For intra-EU DR, add AddReplicaRegions: [{ Region: 'eu-central-1', KmsKeyId }].
    });

    const response = await this.secretsClient.send(command);
    
    if (!response.ARN) {
      throw new Error('Failed to create secret');
    }

    return response.ARN;
  }

  async getCredentials(secretArn: string): Promise<StoredCredentials> {
    const command = new GetSecretValueCommand({
      SecretId: secretArn,
      VersionStage: 'AWSCURRENT',
    });

    try {
      const response = await this.secretsClient.send(command);
      
      if (!response.SecretString) {
        throw new Error('Secret value is empty');
      }

      return JSON.parse(response.SecretString);
    } catch (error) {
      console.error('Failed to retrieve credentials:', error);
      throw new Error('Failed to retrieve connection credentials');
    }
  }

  async updateCredentials(secretArn: string, credentials: Partial<StoredCredentials>): Promise<string> {
    // Get existing credentials
    const existingCredentials = await this.getCredentials(secretArn);
    
    // Merge with new credentials
    const updatedCredentials = {
      ...existingCredentials,
      ...credentials,
    };

    // Update secret
    const command = new UpdateSecretCommand({
      SecretId: secretArn,
      SecretString: JSON.stringify(updatedCredentials),
    });

    await this.secretsClient.send(command);
    return secretArn;
  }

  async deleteCredentials(secretArn: string): Promise<void> {
    const command = new DeleteSecretCommand({
      SecretId: secretArn,
      ForceDeleteWithoutRecovery: false, // Allow 7-day recovery period
    });

    try {
      await this.secretsClient.send(command);
    } catch (error) {
      console.error('Failed to delete credentials:', error);
      // Don't throw - deletion might fail if secret is already deleted
    }
  }

  private async getOrCreateCustomerKMSKey(customerId: string): Promise<string> {
    const keyAlias = `alias/heliosiq-customer-${customerId}`;
    
    try {
      // Try to get existing key
      const describeCommand = new DescribeKeyCommand({
        KeyId: keyAlias,
      });
      
      const response = await this.kmsClient.send(describeCommand);
      return response.KeyMetadata?.KeyId || '';
    } catch (error) {
      // Key doesn't exist, create it
      const createCommand = new CreateKeyCommand({
        Description: `HeliosIQ encryption key for customer ${customerId}`,
        KeyUsage: 'ENCRYPT_DECRYPT',
        Origin: 'AWS_KMS',
        KeySpec: 'SYMMETRIC_DEFAULT',
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'Enable IAM User Permissions',
              Effect: 'Allow',
              Principal: {
                AWS: `arn:aws:iam::${process.env.AWS_ACCOUNT_ID}:root`
              },
              Action: 'kms:*',
              Resource: '*'
            },
            {
              Sid: 'Allow HeliosIQ Service Access',
              Effect: 'Allow',
              Principal: {
                AWS: `arn:aws:iam::${process.env.AWS_ACCOUNT_ID}:role/HeliosIQ-ServiceRole`
              },
              Action: [
                'kms:Encrypt',
                'kms:Decrypt',
                'kms:ReEncrypt*',
                'kms:GenerateDataKey*',
                'kms:DescribeKey'
              ],
              Resource: '*',
              Condition: {
                StringEquals: {
                  'kms:ViaService': `secretsmanager.${process.env.AWS_REGION || 'eu-west-1'}.amazonaws.com`
                }
              }
            }
          ]
        }),
        Tags: [
          {
            TagKey: 'Service',
            TagValue: 'HeliosIQ'
          },
          {
            TagKey: 'Customer',
            TagValue: customerId
          },
          {
            TagKey: 'Purpose',
            TagValue: 'DataConnectionEncryption'
          }
        ]
      });

      const createResponse = await this.kmsClient.send(createCommand);
      
      if (!createResponse.KeyMetadata?.KeyId) {
        throw new Error('Failed to create KMS key');
      }

      return createResponse.KeyMetadata.KeyId;
    }
  }

  async rotateCredentials(secretArn: string, newCredentials: StoredCredentials): Promise<void> {
    // This would be called by a scheduled Lambda for automatic credential rotation
    await this.updateCredentials(secretArn, newCredentials);
    
    // Log rotation event for audit
    console.log(`Credentials rotated for secret: ${secretArn}`);
  }

  async validateCredentialSecurity(credentials: StoredCredentials): Promise<{
    isSecure: boolean;
    warnings: string[];
    recommendations: string[];
  }> {
    const warnings: string[] = [];
    const recommendations: string[] = [];

    // Check for weak passwords
    if (credentials.password && credentials.password.length < 12) {
      warnings.push('Password is shorter than 12 characters');
      recommendations.push('Use a password with at least 12 characters');
    }

    // Check for default usernames
    const defaultUsernames = ['admin', 'root', 'user', 'test', 'guest'];
    if (credentials.username && defaultUsernames.includes(credentials.username.toLowerCase())) {
      warnings.push('Using a common default username');
      recommendations.push('Use a unique, non-default username');
    }

    // Check SSL configuration
    if (credentials.ssl === false) {
      warnings.push('SSL/TLS is disabled');
      recommendations.push('Enable SSL/TLS encryption for secure communication');
    }

    // Check for API tokens in URLs
    if (credentials.host && (credentials.host.includes('token=') || credentials.host.includes('key='))) {
      warnings.push('API credentials found in host URL');
      recommendations.push('Store API credentials separately from connection URLs');
    }

    return {
      isSecure: warnings.length === 0,
      warnings,
      recommendations,
    };
  }
}