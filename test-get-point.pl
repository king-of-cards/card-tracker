use strict;
use warnings;
use LWP::UserAgent;

my $ua  = LWP::UserAgent->new;
my $url = 'http://localhost:8080/api/dispatch/comparison?division=KOC%20Cards&vendor=KOC&batchLabel=2026';

my $response = $ua->get($url);

print "Status Code: ", $response->code, "\n";
print "Response Body:\n", $response->decoded_content, "\n";