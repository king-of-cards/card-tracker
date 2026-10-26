use strict;
use warnings;
use LWP::UserAgent;
use JSON;

my $ua  = LWP::UserAgent->new;
my $url = 'http://localhost:8080/api/dispatch/branch-upload';

my $payload = {
    division   => "KOC Cards",
    vendor     => "KOC",
    batchLabel => "2026",
    branchName => "Hoodi",
    uploadedBy => "Hoodi Staff",
    filename   => "hoodi.xlsx",
    skus       => [
        { sku => "KOC-001", qty => 10 },
        { sku => "KOC-002", qty => 5 },
    ],
};


my $json_body = encode_json($payload);


my $response = $ua->post(
    $url,
    'Content-Type' => 'application/json',
    Content        => $json_body,
);

print "Status Code: ", $response->code, "\n";
print "Response Body:\n", $response->decoded_content, "\n";


